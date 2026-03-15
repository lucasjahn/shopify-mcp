import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError, buildFieldSelection } from "../lib/toolUtils.js";

/** Map of selectable field names → GraphQL fragments for products */
const PRODUCT_FIELD_MAP: Record<string, string> = {
  id: "id",
  title: "title",
  description: "description",
  handle: "handle",
  status: "status",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  totalInventory: "totalInventory",
  priceRange: "priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }",
  media: "media(first: 1) { edges { node { ... on MediaImage { id image { url altText } } } } }",
  variants: "variants(first: 5) { edges { node { id title price inventoryQuantity sku } } }",
};

const AVAILABLE_PRODUCT_FIELDS = Object.keys(PRODUCT_FIELD_MAP) as [string, ...string[]];

// Input schema for getProducts
const GetProductsInputSchema = z.object({
  searchTitle: z.string().optional().describe("Search by title (convenience filter, wraps in title:*...*). Use 'query' for advanced filtering."),
  limit: z.number().min(1).max(250).default(10)
    .describe("Number of products to return (default 10, max 250)"),
  after: z.string().optional().describe("Cursor for forward pagination"),
  before: z.string().optional().describe("Cursor for backward pagination"),
  sortKey: z.enum([
    "CREATED_AT", "ID", "INVENTORY_TOTAL", "PRODUCT_TYPE",
    "PUBLISHED_AT", "RELEVANCE", "TITLE", "UPDATED_AT", "VENDOR"
  ]).optional().describe("Sort key for products"),
  reverse: z.boolean().optional().describe("Reverse the sort order"),
  query: z.string().optional().describe("Raw query string for advanced filtering (e.g. 'status:active vendor:Nike tag:sale')"),
  fields: z
    .array(z.enum(AVAILABLE_PRODUCT_FIELDS))
    .optional()
    .describe(
      "Select which fields to return to reduce response size. " +
      "When omitted, all fields are returned. Always includes 'id'. " +
      `Available: ${AVAILABLE_PRODUCT_FIELDS.join(", ")}`,
    ),
});

type GetProductsInput = z.infer<typeof GetProductsInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getProducts = {
  name: "get-products",
  description: "Get all products or search by title. Supports field selection via 'fields' to reduce response size (e.g. fields: [\"id\", \"title\"] for minimal data).",
  schema: GetProductsInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetProductsInput) => {
    try {
      const { searchTitle, limit, after, before, sortKey, reverse, query: rawQuery, fields } = input;

      // Build query string from convenience filters and raw query
      const queryParts: string[] = [];
      if (searchTitle) {
        queryParts.push(`title:*${searchTitle}*`);
      }
      if (rawQuery) {
        queryParts.push(rawQuery);
      }
      const queryFilter = queryParts.join(" ") || undefined;

      const fieldSelection = buildFieldSelection(PRODUCT_FIELD_MAP, fields);

      const query = `
        query GetProducts($first: Int!, $query: String, $after: String, $before: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
          products(first: $first, query: $query, after: $after, before: $before, sortKey: $sortKey, reverse: $reverse) {
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
        products: any;
      };

      // When custom fields are specified, return raw nodes to avoid formatter errors
      if (fields) {
        const products = data.products.edges.map((edge: any) => edge.node);
        return {
          products,
          pageInfo: data.products.pageInfo
        };
      }

      // Default: full formatting
      const products = data.products.edges.map((edge: any) => {
        const product = edge.node;

        // Format variants
        const variants = product.variants.edges.map((variantEdge: any) => ({
          id: variantEdge.node.id,
          title: variantEdge.node.title,
          price: variantEdge.node.price,
          inventoryQuantity: variantEdge.node.inventoryQuantity,
          sku: variantEdge.node.sku
        }));

        // Get first image if it exists
        const firstMedia = product.media.edges.find((e: any) => e.node.image);
        const imageUrl = firstMedia?.node.image?.url || null;

        return {
          id: product.id,
          title: product.title,
          description: product.description,
          handle: product.handle,
          status: product.status,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
          totalInventory: product.totalInventory,
          priceRange: {
            minPrice: {
              amount: product.priceRangeV2.minVariantPrice.amount,
              currencyCode: product.priceRangeV2.minVariantPrice.currencyCode
            },
            maxPrice: {
              amount: product.priceRangeV2.maxVariantPrice.amount,
              currencyCode: product.priceRangeV2.maxVariantPrice.currencyCode
            }
          },
          imageUrl,
          variants
        };
      });

      return {
        products,
        pageInfo: data.products.pageInfo
      };
    } catch (error) {
      handleToolError("fetch products", error);
    }
  }
};

export { getProducts };
