import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError, edgesToNodes, buildFieldSelection, type ShopifyConnection } from "../lib/toolUtils.js";
import { formatOrderSummary } from "../lib/formatters.js";

/** Map of selectable field names → GraphQL fragments for orders */
const ORDER_FIELD_MAP: Record<string, string> = {
  id: "id",
  name: "name",
  createdAt: "createdAt",
  financialStatus: "displayFinancialStatus",
  fulfillmentStatus: "displayFulfillmentStatus",
  totalPrice: "totalPriceSet { shopMoney { amount currencyCode } }",
  subtotalPrice: "subtotalPriceSet { shopMoney { amount currencyCode } }",
  shippingPrice: "totalShippingPriceSet { shopMoney { amount currencyCode } }",
  tax: "totalTaxSet { shopMoney { amount currencyCode } }",
  customer: "customer { id firstName lastName defaultEmailAddress { emailAddress } }",
  lineItems: "lineItems(first: 5) { edges { node { id title quantity originalTotalSet { shopMoney { amount currencyCode } } variant { id title sku } } } }",
  tags: "tags",
  note: "note",
};

const AVAILABLE_ORDER_FIELDS = Object.keys(ORDER_FIELD_MAP) as [string, ...string[]];

// Input schema for getting customer orders
const GetCustomerOrdersInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, "Customer ID must be numeric").describe("Numeric customer ID (e.g. 7832529321). Do not pass a full GID."),
  limit: z.number().min(1).max(250).default(10)
    .describe("Number of orders to return (default 10, max 250)"),
  countOnly: z
    .boolean()
    .optional()
    .describe(
      "IMPORTANT: Use this to check result set size before fetching data. " +
      "Returns only { count: N } without any resource data, saving significant context. " +
      "Recommended before paginating large result sets.",
    ),
  after: z.string().optional().describe("Cursor for forward pagination"),
  before: z.string().optional().describe("Cursor for backward pagination"),
  sortKey: z.enum([
    "CREATED_AT", "ORDER_NUMBER", "TOTAL_PRICE", "FINANCIAL_STATUS",
    "FULFILLMENT_STATUS", "UPDATED_AT", "CUSTOMER_NAME", "PROCESSED_AT",
    "ID", "RELEVANCE"
  ]).optional().describe("Sort key for orders"),
  reverse: z.boolean().optional().describe("Reverse the sort order"),
  fields: z
    .array(z.enum(AVAILABLE_ORDER_FIELDS))
    .optional()
    .describe(
      "IMPORTANT: Always specify this to minimize token usage and avoid flooding context with unnecessary data. " +
      "Only the listed fields will be fetched from the API and returned. 'id' is always included. " +
      "If you are unsure which fields are needed, ask the user before fetching all fields. " +
      "Example: [\"id\", \"name\"] returns only order GID and order number. " +
      `Available: ${AVAILABLE_ORDER_FIELDS.join(", ")}`,
    ),
});

type GetCustomerOrdersInput = z.infer<typeof GetCustomerOrdersInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getCustomerOrders = {
  name: "get-customer-orders",
  description: "Get orders for a specific customer. Supports field selection via 'fields' to reduce response size.",
  schema: GetCustomerOrdersInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetCustomerOrdersInput) => {
    try {
      const { customerId, limit, after, before, sortKey, reverse, fields, countOnly } = input;

      // Count-only mode: return just the count
      if (countOnly) {
        const countQuery = `
          query GetCustomerOrdersCount($query: String) {
            ordersCount(query: $query) { count }
          }
        `;
        const countData = (await shopifyClient.request(countQuery, { query: `customer_id:${customerId}` })) as {
          ordersCount: { count: number };
        };
        return { count: countData.ordersCount.count };
      }

      const fieldSelection = buildFieldSelection(ORDER_FIELD_MAP, fields);

      const query = `
        query GetCustomerOrders($query: String!, $first: Int!, $after: String, $before: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
          orders(query: $query, first: $first, after: $after, before: $before, sortKey: $sortKey, reverse: $reverse) {
            edges {
              node {
                ${fieldSelection}
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `;

      // We use the query parameter to filter orders by customer ID
      const variables = {
        query: `customer_id:${customerId}`,
        first: limit,
        ...(after && { after }),
        ...(before && { before }),
        ...(sortKey && { sortKey }),
        ...(reverse !== undefined && { reverse })
      };

      const data = (await shopifyClient.request(query, variables)) as {
        orders: ShopifyConnection<any>;
      };

      // When custom fields are specified, return raw nodes with connection sub-fields flattened
      if (fields) {
        const orders = edgesToNodes(data.orders).map((order: any) => {
          const result: any = { ...order };
          if (result.lineItems) {
            result.lineItems = edgesToNodes(result.lineItems);
          }
          return result;
        });
        return {
          orders,
          pageInfo: data.orders.pageInfo
        };
      }

      const orders = edgesToNodes(data.orders).map(formatOrderSummary);

      return {
        orders,
        pageInfo: data.orders.pageInfo
      };
    } catch (error) {
      handleToolError("fetch customer orders", error);
    }
  }
};

export { getCustomerOrders };
