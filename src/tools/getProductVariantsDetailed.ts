import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { edgesToNodes, handleToolError, buildFieldSelection } from "../lib/toolUtils.js";

/** Map of selectable field names → GraphQL fragments for variant nodes */
const VARIANT_FIELD_MAP: Record<string, string> = {
  id: "id",
  title: "title",
  displayName: "displayName",
  sku: "sku",
  barcode: "barcode",
  price: "price",
  compareAtPrice: "compareAtPrice",
  taxable: "taxable",
  availableForSale: "availableForSale",
  inventoryQuantity: "inventoryQuantity",
  position: "position",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  selectedOptions: "selectedOptions { name value }",
  media: "media(first: 1) { edges { node { ... on MediaImage { image { url altText } } } } }",
  inventoryItem: "inventoryItem { id tracked requiresShipping unitCost { amount currencyCode } measurement { weight { unit value } } }",
  metafields: "metafields(first: 25) { edges { node { namespace key value type } } }",
};

const AVAILABLE_VARIANT_FIELDS = Object.keys(VARIANT_FIELD_MAP) as [string, ...string[]];

const GetProductVariantsDetailedInputSchema = z.object({
  productId: z
    .string()
    .min(1)
    .describe(
      "The product ID (e.g. gid://shopify/Product/123 or just 123)",
    ),
  first: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .optional()
    .describe("Number of variants to return (default 50, max 100)"),
  fields: z
    .array(z.enum(AVAILABLE_VARIANT_FIELDS))
    .optional()
    .describe(
      "IMPORTANT: Always specify this to minimize token usage and avoid flooding context with unnecessary data. " +
      "Only the listed fields will be fetched for each variant. 'id' is always included. " +
      "If you are unsure which fields are needed, ask the user before fetching all fields. " +
      "Example: [\"id\", \"price\", \"sku\"] returns only variant GID, price, and SKU. " +
      `Available: ${AVAILABLE_VARIANT_FIELDS.join(", ")}`,
    ),
});
type GetProductVariantsDetailedInput = z.infer<
  typeof GetProductVariantsDetailedInputSchema
>;

let shopifyClient: GraphQLClient;

const getProductVariantsDetailed = {
  name: "get-product-variants-detailed",
  description:
    "Get all variant fields for a product: pricing, inventory, barcode, weight, tax code, selected options, metafields, and image. Supports field selection via 'fields' to reduce response size.",
  schema: GetProductVariantsDetailedInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetProductVariantsDetailedInput) => {
    try {
      const productId = input.productId.startsWith("gid://")
        ? input.productId
        : `gid://shopify/Product/${input.productId}`;

      const variantFieldSelection = buildFieldSelection(VARIANT_FIELD_MAP, input.fields);

      const query = `
        query GetProductVariantsDetailed($id: ID!, $first: Int!) {
          product(id: $id) {
            id
            title
            variants(first: $first) {
              edges {
                node {
                  ${variantFieldSelection}
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;

      const data: any = await shopifyClient.request(query, {
        id: productId,
        first: input.first ?? 50,
      });

      if (!data.product) {
        throw new Error(`Product not found: ${productId}`);
      }

      // When custom fields are specified, return raw nodes (run edgesToNodes on connection fields)
      if (input.fields) {
        const variants = edgesToNodes(data.product.variants).map(
          (variant: any) => {
            const result: any = { ...variant };
            if (result.media) {
              const mediaNodes = edgesToNodes(result.media);
              const firstImage = mediaNodes.find((m: any) => m.image) as any;
              result.image = firstImage?.image ?? null;
              delete result.media;
            }
            if (result.metafields) {
              result.metafields = edgesToNodes(result.metafields);
            }
            return result;
          },
        );

        return {
          productId: data.product.id,
          productTitle: data.product.title,
          variantsCount: variants.length,
          variants,
          pageInfo: data.product.variants.pageInfo,
        };
      }

      // Default: full formatting
      const variants = edgesToNodes(data.product.variants).map(
        (variant: any) => {
          const mediaNodes = variant.media
            ? edgesToNodes(variant.media)
            : [];
          const firstImage = mediaNodes.find(
            (m: any) => m.image,
          ) as any;
          const image = firstImage?.image ?? null;
          delete variant.media;
          return {
            ...variant,
            image,
            metafields: variant.metafields
              ? edgesToNodes(variant.metafields)
              : [],
          };
        },
      );

      return {
        productId: data.product.id,
        productTitle: data.product.title,
        variantsCount: variants.length,
        variants,
        pageInfo: data.product.variants.pageInfo,
      };
    } catch (error) {
      handleToolError("fetch product variants", error);
    }
  },
};

export { getProductVariantsDetailed };
