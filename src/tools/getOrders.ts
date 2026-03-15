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
      "Select which fields to return to reduce response size. " +
      "When omitted, all fields are returned. Always includes 'id'. " +
      `Available: ${AVAILABLE_ORDER_FIELDS.join(", ")}`,
    ),
});

type GetOrdersInput = z.infer<typeof GetOrdersInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getOrders = {
  name: "get-orders",
  description: "Get orders with optional filtering by status. Supports field selection via 'fields' to reduce response size (e.g. fields: [\"id\", \"name\"] for minimal data).",
  schema: GetOrdersInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetOrdersInput) => {
    try {
      const { status, limit, after, before, sortKey, reverse, query: rawQuery, fields } = input;

      // Build query filters
      const queryParts: string[] = [];
      if (status !== "any") {
        queryParts.push(`status:${status}`);
      }
      if (rawQuery) {
        queryParts.push(rawQuery);
      }
      const queryFilter = queryParts.join(" ") || undefined;

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

      // When custom fields are specified, return raw nodes (formatter expects all fields)
      const orders = fields
        ? edgesToNodes(data.orders)
        : edgesToNodes(data.orders).map(formatOrderSummary);

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
