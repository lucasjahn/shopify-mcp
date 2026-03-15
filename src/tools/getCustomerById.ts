import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError, edgesToNodes, buildFieldSelection } from "../lib/toolUtils.js";

/** Map of selectable field names → GraphQL fragments for customer-by-id */
const CUSTOMER_BY_ID_FIELD_MAP: Record<string, string> = {
  id: "id",
  firstName: "firstName",
  lastName: "lastName",
  email: "defaultEmailAddress { emailAddress }",
  phone: "defaultPhoneNumber { phoneNumber }",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  tags: "tags",
  note: "note",
  taxExempt: "taxExempt",
  defaultAddress: "defaultAddress { address1 address2 city provinceCode zip country phone }",
  addresses: "addressesV2(first: 10) { edges { node { address1 address2 city provinceCode zip country phone } } }",
  amountSpent: "amountSpent { amount currencyCode }",
  numberOfOrders: "numberOfOrders",
  metafields: "metafields(first: 10) { edges { node { id namespace key value } } }",
};

const AVAILABLE_CUSTOMER_BY_ID_FIELDS = Object.keys(CUSTOMER_BY_ID_FIELD_MAP) as [string, ...string[]];

// Input schema for getting a customer by ID
const GetCustomerByIdInputSchema = z.object({
  id: z.string().regex(/^\d+$/, "Customer ID must be numeric").describe("Numeric customer ID (e.g. 7832529321). Do not pass a full GID."),
  fields: z
    .array(z.enum(AVAILABLE_CUSTOMER_BY_ID_FIELDS))
    .optional()
    .describe(
      "IMPORTANT: Always specify this to minimize token usage and avoid flooding context with unnecessary data. " +
      "Only the listed fields will be fetched from the API and returned. 'id' is always included. " +
      "If you are unsure which fields are needed, ask the user before fetching all fields. " +
      "Example: [\"id\", \"email\"] returns only GID and email. " +
      `Available: ${AVAILABLE_CUSTOMER_BY_ID_FIELDS.join(", ")}`,
    ),
});

type GetCustomerByIdInput = z.infer<typeof GetCustomerByIdInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getCustomerById = {
  name: "get-customer-by-id",
  description: "Get a single customer by ID. Supports field selection via 'fields' to reduce response size.",
  schema: GetCustomerByIdInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetCustomerByIdInput) => {
    try {
      const { id, fields } = input;

      // Convert numeric ID to GID format
      const customerGid = `gid://shopify/Customer/${id}`;

      const fieldSelection = buildFieldSelection(CUSTOMER_BY_ID_FIELD_MAP, fields);

      const query = `
        query GetCustomerById($id: ID!) {
          customer(id: $id) {
            ${fieldSelection}
          }
        }
      `;

      const variables = {
        id: customerGid
      };

      const data = (await shopifyClient.request(query, variables)) as {
        customer: any;
      };

      if (!data.customer) {
        throw new Error(`Customer with ID ${id} not found`);
      }

      const customer = data.customer;

      // When custom fields are specified, return raw nodes (run edgesToNodes on connection fields)
      if (fields) {
        const result: any = { ...customer };
        if (result.addressesV2) {
          result.addresses = edgesToNodes(result.addressesV2);
          delete result.addressesV2;
        }
        if (result.metafields) {
          result.metafields = edgesToNodes(result.metafields);
        }
        return { customer: result };
      }

      // Default: full formatting
      const metafields = customer.metafields
        ? edgesToNodes(customer.metafields)
        : [];
      const addresses = customer.addressesV2
        ? edgesToNodes(customer.addressesV2)
        : [];

      return {
        customer: {
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.defaultEmailAddress?.emailAddress || null,
          phone: customer.defaultPhoneNumber?.phoneNumber || null,
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          tags: customer.tags,
          note: customer.note,
          taxExempt: customer.taxExempt,
          defaultAddress: customer.defaultAddress,
          addresses,
          amountSpent: customer.amountSpent,
          numberOfOrders: customer.numberOfOrders,
          metafields
        }
      };
    } catch (error) {
      handleToolError("fetch customer", error);
    }
  }
};

export { getCustomerById };
