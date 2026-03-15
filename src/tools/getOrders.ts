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
  shippingAddress: "shippingAddress { address1 address2 city provinceCode zip country phone }",
  lineItems: "lineItems(first: 10) { edges { node { id title quantity originalTotalSet { shopMoney { amount currencyCode } } variant { id title sku } } } }",
  tags: "tags",
  note: "note",
};

const AVAILABLE_ORDER_FIELDS = Object.keys(ORDER_FIELD_MAP) as [string, ...string[]];

// Input schema for getOrders
const GetOrdersInputSchema = z.object({
  status: z.enum(["any", "open", "closed", "cancelled"]).default("any"),
  limit: z.number().min(1).max(250).default(10)
    .describe("Number of orders to return (default 10, max 250)"),
  after: z.string().optional().describe("Cursor for forward pagination"),
  before: z.string().optional().describe("Cursor for backward pagination"),
  sortKey: z.enum([
    "CREATED_AT", "ORDER_NUMBER", "TOTAL_PRICE", "FINANCIAL_STATUS",
    "FULFILLMENT_STATUS", "UPDATED_AT", "CUSTOMER_NAME", "PROCESSED_AT",
    "ID", "RELEVANCE"
  ]).optional().describe("Sort key for orders"),
  reverse: z.boolean().optional().describe("Reverse the sort order"),
  query: z.string().optional().describe("Raw query string for advanced filtering (e.g. 'financial_status:paid fulfillment_status:shipped')"),
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
  countOnly: z
    .boolean()
    .optional()
    .describe(
      "IMPORTANT: Use this to check result set size before fetching data. " +
      "Returns only { count: N } without any resource data, saving significant context. " +
      "Recommended before paginating large result sets.",
    ),
});

type GetOrdersInput = z.infer<typeof GetOrdersInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getOrders = {
  name: "get-orders",
  description: "Get orders with optional filtering by status. Supports field selection via 'fields' and 'countOnly' to get just the count.",
  schema: GetOrdersInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetOrdersInput) => {
    try {
      const { status, limit, after, before, sortKey, reverse, query: rawQuery, fields, countOnly } = input;

      // Build query filters
      const queryParts: string[] = [];
      if (status !== "any") {
        queryParts.push(`status:${status}`);
      }
      if (rawQuery) {
        queryParts.push(rawQuery);
      }
      const queryFilter = queryParts.join(" ") || undefined;

      // Count-only mode: return just the count
      if (countOnly) {
        const countQuery = `
          query GetOrdersCount($query: String) {
            ordersCount(query: $query) { count }
          }
        `;
        const countData = (await shopifyClient.request(countQuery, { query: queryFilter })) as {
          ordersCount: { count: number };
        };
        return { count: countData.ordersCount.count };
      }

      const fieldSelection = buildFieldSelection(ORDER_FIELD_MAP, fields);

      const query = `
        query GetOrders($first: Int!, $query: String, $after: String, $before: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
          orders(first: $first, query: $query, after: $after, before: $before, sortKey: $sortKey, reverse: $reverse) {
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

      const variables = {
        first: limit,
        query: queryFilter,
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
      handleToolError("fetch orders", error);
    }
  }
};

export { getOrders };
