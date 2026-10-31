// COOP_COMPONENT_MARKET_V1
//
// Answers the two SKIN-component market calls the client really sends and nobody
// answered before:
//   eve_public.cosmetic.market.component.listing.api.GetAll
//   eve_public.cosmetic.market.component.listing.api.InitiatePurchaseListing
//
// The proto shape is CCP's (proto3, byte offsets from the client's own generated
// descriptors): Attributes carries the price in one of ISK/PLEX, the component item
// type it sells, the bundle size and the sale end. There is no seller field, which
// is why a purchase is a real ISK sink rather than a transfer to an invented seller.
const path = require("node:path");
const protobuf = require("protobufjs");
const {
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const LISTING_API = "eve_public.cosmetic.market.component.listing.api";
const LISTING = "eve_public.cosmetic.market.component.listing";
const COMPONENT_GROUP_ID = 4726;
const MAX_SEED_LISTINGS = 120;
// A design element this world sells for a stated price; see the catalog comment.
const DEFAULT_COMPONENT_PRICE_ISK = 250000;

const PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: { type: "int64", id: 1 },
                nanos: { type: "int32", id: 2 },
              },
            },
          },
        },
      },
    },
    eve_public: {
      nested: {
        inventory: {
          nested: {
            genericitemtype: {
              nested: {
                Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
              },
            },
          },
        },
        isk: {
          nested: {
            Currency: {
              fields: {
                units: { type: "sint64", id: 1 },
                nanos: { type: "sint32", id: 2 },
              },
            },
          },
        },
        plex: {
          nested: {
            Currency: { fields: { total_in_cents: { type: "sint64", id: 1 } } },
          },
        },
        cosmetic: {
          nested: {
            market: {
              nested: {
                transaction: {
                  nested: {
                    Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                  },
                },
                component: {
                  nested: {
                    listing: {
                      nested: {
                        Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                        Attributes: {
                          fields: {
                            sale_end: { type: "google.protobuf.Timestamp", id: 2 },
                            isk: { type: "eve_public.isk.Currency", id: 3 },
                            plex: { type: "eve_public.plex.Currency", id: 4 },
                            component_item: {
                              type: "eve_public.inventory.genericitemtype.Identifier",
                              id: 5,
                            },
                            bundle_size: { type: "uint64", id: 6 },
                            discount_percent: { type: "uint32", id: 7 },
                          },
                          oneofs: { price: { oneof: ["isk", "plex"] } },
                        },
                        Entry: {
                          fields: {
                            id: { type: `${LISTING}.Identifier`, id: 1 },
                            attributes: { type: `${LISTING}.Attributes`, id: 2 },
                          },
                        },
                        api: {
                          nested: {
                            GetAllRequest: { fields: {} },
                            GetAllResponse: {
                              fields: { listings: { type: `${LISTING}.Entry`, id: 1, rule: "repeated" } },
                            },
                            InitiatePurchaseListingRequest: {
                              fields: {
                                listing: { type: `${LISTING}.Identifier`, id: 1 },
                                quantity: { type: "uint32", id: 2 },
                                immediately_activate: { type: "bool", id: 3 },
                              },
                            },
                            InitiatePurchaseListingResponse: {
                              fields: {
                                transaction: {
                                  type: "eve_public.cosmetic.market.transaction.Identifier",
                                  id: 1,
                                },
                                immediately_activate: { type: "bool", id: 2 },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.market.component.listing.api.GetAllRequest",
  "eve_public.cosmetic.market.component.listing.api.InitiatePurchaseListingRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function entryOf(row) {
  return {
    id: { uuid: Buffer.from(String(row.uuid || ""), "utf8").subarray(0, 16) },
    attributes: {
      sale_end: timestampOf(row.saleEndMs),
      isk: { units: Math.max(0, Number(row.priceISK) || 0), nanos: 0 },
      component_item: { sequential: Math.max(0, Number(row.typeID) || 0) },
      bundle_size: Math.max(1, Number(row.bundleSize) || 1),
      discount_percent: 0,
    },
  };
}

// The catalog a seed may draw from: real component types, with CCP's base price.
function componentCatalog(limit = MAX_SEED_LISTINGS) {
  try {
    const referenceData = require(path.join(
      __dirname,
      "../../../services/_shared/referenceData",
    ));
    const table = referenceData.readStaticTable("itemTypes");
    const rows = table && table.types;
    const list = Array.isArray(rows) ? rows : Object.values(rows || {});
    const out = [];
    for (const row of list) {
      if (out.length >= limit) break;
      if (!row || Number(row.groupID) !== COMPONENT_GROUP_ID) continue;
      if (row.published === false) continue;
      const typeID = Number(row.typeID) || 0;
      const basePrice = Number(row.basePrice) || 0;
      if (!(typeID > 0)) continue;
      // This item-type table carries 0 for a component's base price, so the world
      // prices a design element itself. It is a stated world price, not a claim that
      // CCP published it; where a base price does exist it wins.
      out.push({
        typeID,
        basePrice: basePrice > 0 ? basePrice : DEFAULT_COMPONENT_PRICE_ISK,
        bundleSize: 1,
        stock: 100,
      });
    }
    return out;
  } catch (_error) {
    return [];
  }
}

function createComponentListingGatewayService(context = {}) {
  const market = context.componentListings || require(path.join(
    __dirname,
    "../../../space/coopComponentListings",
  )).shared();
  const types = {
    getAllResponse: PROTO_ROOT.lookupType(`${LISTING_API}.GetAllResponse`),
    purchaseRequest: PROTO_ROOT.lookupType(`${LISTING_API}.InitiatePurchaseListingRequest`),
    purchaseResponse: PROTO_ROOT.lookupType(`${LISTING_API}.InitiatePurchaseListingResponse`),
  };

  function encodePayload(type, payload) {
    const error = type.verify(payload);
    if (error) throw Error("payload does not match the proto: " + error);
    return Buffer.from(type.encode(type.create(payload)).finish());
  }

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  function ok(responseTypeName, type = null, payload = null) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: type ? encodePayload(type, payload || {}) : Buffer.alloc(0),
    };
  }

  function refusal(status, responseTypeName) {
    const table = {
      NO_CHARACTER: [7, "no character in this session"],
      NOT_FOUND: [5, "no such listing"],
      NOT_ACTIVE: [9, "that listing is no longer for sale"],
      OUT_OF_STOCK: [9, "that listing has no stock left"],
      UUID_REQUIRED: [3, "a listing id is required"],
      PAYMENT_FAILED: [13, "the payment could not be made"],
      DELIVERY_FAILED: [13, "the components could not be delivered (are you docked?)"],
      DISABLED: [9, "the component market is not open in this world"],
    };
    const row = table[status] || [13, `component listing request failed: ${status}`];
    return {
      statusCode: row[0],
      statusMessage: row[1],
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "component-market-listings",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) return null;

      if (requestTypeName === "eve_public.cosmetic.market.component.listing.api.GetAllRequest") {
        let result = market.list();
        if (result.status === "OK" && result.listings.length === 0) {
          // An empty market is a real answer, but the world can afford to stock it
          // from real component types; the seed is env-gated and idempotent.
          market.seed(componentCatalog());
          result = market.list();
        }
        if (result.status !== "OK") {
          return ok("eve_public.cosmetic.market.component.listing.api.GetAllResponse",
            types.getAllResponse, { listings: [] });
        }
        return ok("eve_public.cosmetic.market.component.listing.api.GetAllResponse",
          types.getAllResponse, { listings: result.listings.map(entryOf) });
      }

      const request = decode(types.purchaseRequest, requestEnvelope);
      const characterID = Number(getActiveCharacterID(requestEnvelope) || 0);
      const uuid = Buffer.from((request.listing && request.listing.uuid) || Buffer.alloc(0))
        .toString("utf8");
      const result = market.purchase({
        uuid,
        characterID,
        quantity: request.quantity || 1,
      });
      if (result.status !== "SOLD") {
        return refusal(result.status,
          "eve_public.cosmetic.market.component.listing.api.InitiatePurchaseListingResponse");
      }
      return ok("eve_public.cosmetic.market.component.listing.api.InitiatePurchaseListingResponse",
        types.purchaseResponse, {
          transaction: { uuid: Buffer.from(String(result.transactionID || ""), "utf8").subarray(0, 16) },
          immediately_activate: result.immediatelyActivate === true,
        });
    },
  };
}

module.exports = { createComponentListingGatewayService, componentCatalog,
  HANDLED_REQUEST_TYPES, PROTO_ROOT };
