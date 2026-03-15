import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError, edgesToNodes, buildFieldSelection } from "../lib/toolUtils.js";

/** Map of selectable field names → GraphQL fragments for product-by-id */
const PRODUCT_BY_ID_FIELD_MAP: Record<string, string> = {
  id: "id",
  title: "title",
  description: "description",
  descriptionHtml: "descriptionHtml",
  handle: "handle",
  status: "status",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  totalInventory: "totalInventory",
  priceRange: "priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }",
  media: "media(first: 5) { edges { node { ... on MediaImage { id image { url altText width height } } } } }",
  variants: "variants(first: 20) { edges { node { id title price inventoryQuantity sku selectedOptions { name value } } } }",
  collections: "collections(first: 5) { edges { node { id title } } }",
  seo: "seo { title description }",
  options: "options { id name position optionValues { id name } }",
  tags: "tags",
  vendor: "vendor",
  productType: "productType",
};

const AVAILABLE_PRODUCT_BY_ID_FIELDS = Object.keys(PRODUCT_BY_ID_FIELD_MAP) as [string, ...string[]];

// Input schema for getProductById
const GetProductByIdInputSchema = z.object({
  productId: z.string().min(1).describe("The product ID (e.g. gid://shopify/Product/123 or just 123)"),
  fields: z
    .array(z.enum(AVAILABLE_PRODUCT_BY_ID_FIELDS))
    .optional()
    .describe(
      "IMPORTANT: Always specify this to minimize token usage and avoid flooding context with unnecessary data. " +
      "Only the listed fields will be fetched from the API and returned. 'id' is always included. " +
      "If you are unsure which fields are needed, ask the user before fetching all fields. " +
      "Example: [\"id\", \"title\"] returns only GID and title. " +
      `Available: ${AVAILABLE_PRODUCT_BY_ID_FIELDS.join(", ")}`,
    ),
});

type GetProductByIdInput = z.infer<typeof GetProductByIdInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getProductById = {
  name: "get-product-by-id",
  description: "Get a specific product by ID. Supports field selection via 'fields' to reduce response size.",
  schema: GetProductByIdInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetProductByIdInput) => {
    try {
      const { productId, fields } = input;

      const fieldSelection = buildFieldSelection(PRODUCT_BY_ID_FIELD_MAP, fields);

      const query = `
        query GetProductById($id: ID!) {
          product(id: $id) {
            ${fieldSelection}
          }
        }
      `;

      const variables = {
        id: productId
      };

      const data = (await shopifyClient.request(query, variables)) as {
        product: any;
      };

      if (!data.product) {
        throw new Error(`Product with ID ${productId} not found`);
      }

      const product = data.product;

      // When custom fields are specified, return raw nodes (run edgesToNodes on connection fields)
      if (fields) {
        const result: any = { ...product };
        if (result.media) {
          result.media = edgesToNodes(result.media);
        }
        if (result.variants) {
          result.variants = edgesToNodes(result.variants);
        }
        if (result.collections) {
          result.collections = edgesToNodes(result.collections);
        }
        return { product: result };
      }

      // Default: full formatting
      // Format variants
      const variants = product.variants.edges.map((variantEdge: any) => ({
        id: variantEdge.node.id,
        title: variantEdge.node.title,
        price: variantEdge.node.price,
        inventoryQuantity: variantEdge.node.inventoryQuantity,
        sku: variantEdge.node.sku,
        options: variantEdge.node.selectedOptions
      }));

      // Format images from media
      const images = product.media.edges
        .filter((mediaEdge: any) => mediaEdge.node.image)
        .map((mediaEdge: any) => ({
          id: mediaEdge.node.id,
          url: mediaEdge.node.image.url,
          altText: mediaEdge.node.image.altText,
          width: mediaEdge.node.image.width,
          height: mediaEdge.node.image.height
        }));

      // Format collections
      const collections = product.collections.edges.map(
        (collectionEdge: any) => ({
          id: collectionEdge.node.id,
          title: collectionEdge.node.title
        })
      );

      const formattedProduct = {
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
        images,
        variants,
        collections,
        tags: product.tags,
        vendor: product.vendor,
        productType: product.productType,
        descriptionHtml: product.descriptionHtml,
        seo: product.seo,
        options: product.options
      };

      return { product: formattedProduct };
    } catch (error) {
      handleToolError("fetch product", error);
    }
  }
};

export { getProductById };
