"use strict";
// assetholding (asset + entitlement) and payment schedules / codes.
//
// None of these domains hold any state in this world: there are no ESS or dynamic-resource
// reserve banks, no entitlement rows and no payment schedules or redemption codes. Until now
// every one of these calls got a default-encoded empty message, which the client renders as
// "nothing here" and is indistinguishable from "this exists but is empty".
//
// So the answer says what is true instead of pretending:
//   * a specific asset / entitlement / schedule that does not exist   -> NOT_FOUND
//   * "the active schedule for this type"                             -> empty (the honest
//     shape for "there is none": the response carries one optional schedule)
//   * redeeming an entitlement or a code                             -> FAILED_PRECONDITION
//     with the reason, because nothing can be redeemed that was never granted
//
// If a store for any of these is ever built, this file is the place the real state has to be
// read from - nothing else claims these types.
const protobuf = require("protobufjs");

const { encodePayload } = require("./gatewayServiceHelpers");

const ABSENT_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        assetholding: {
          nested: {
            asset: {
              nested: {
                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                api: {
                  nested: {
                    GetRequest: {
                      fields: { asset: { type: "eve_public.assetholding.asset.Identifier", id: 1 } },
                    },
                    GetResponse: { fields: {} },
                  },
                },
              },
            },
            entitlement: {
              nested: {
                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                api: {
                  nested: {
                    GetRequest: {
                      fields: {
                        entitlement: {
                          type: "eve_public.assetholding.entitlement.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetResponse: { fields: {} },
                    RedeemRequest: {
                      fields: {
                        entitlement: {
                          type: "eve_public.assetholding.entitlement.Identifier",
                          id: 1,
                        },
                        redeem_current_location: { type: "bool", id: 3 },
                      },
                    },
                    RedeemResponse: { fields: {} },
                    admin: {
                      nested: {
                        ExpireRequest: {
                          fields: {
                            entitlement: {
                              type: "eve_public.assetholding.entitlement.Identifier",
                              id: 1,
                            },
                          },
                        },
                        ExpireResponse: { fields: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        payment: {
          nested: {
            schedule: {
              nested: {
                Type: {
                  values: {
                    TYPE_UNSPECIFIED: 0,
                    TYPE_GAMETIME: 1,
                    TYPE_OMEGA: 2,
                  },
                },
                Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
                api: {
                  nested: {
                    GetRequest: {
                      fields: {
                        schedule: { type: "eve_public.payment.schedule.Identifier", id: 1 },
                      },
                    },
                    GetResponse: { fields: {} },
                    GetActiveByTypeRequest: {
                      fields: { type: { type: "Type", id: 1 } },
                    },
                    GetActiveByTypeResponse: {
                      fields: {
                        schedule: { type: "eve_public.payment.schedule.Identifier", id: 1 },
                      },
                    },
                  },
                },
              },
            },
            code: {
              nested: {
                Identifier: { fields: { code: { type: "string", id: 1 } } },
                api: {
                  nested: {
                    RedeemRequest: {
                      fields: { code: { type: "eve_public.payment.code.Identifier", id: 1 } },
                    },
                    RedeemResponse: { fields: {} },
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
  "eve_public.assetholding.asset.api.GetRequest",
  "eve_public.assetholding.entitlement.api.GetRequest",
  "eve_public.assetholding.entitlement.api.RedeemRequest",
  "eve_public.assetholding.entitlement.api.admin.ExpireRequest",
  "eve_public.payment.schedule.api.GetRequest",
  "eve_public.user.license.api.GetRequest",
  "eve_public.payment.schedule.api.GetActiveByTypeRequest",
  "eve_public.payment.code.api.RedeemRequest",
]);

// The client compares these against httplib constants, not against gRPC codes: its own messengers
// read `status_code == 404` to mean "no such record" (see user_licenses/client/messenger/
// request_messenger.pyj). Answering 5/9 here made every one of these "absent" answers an unexpected
// GenericException in the client instead of the "nothing here" it handles.
const NOT_FOUND = 404;
const FAILED_PRECONDITION = 412;

function emptyAnswer(statusCode, statusMessage, responseTypeName, payload, type) {
  return {
    statusCode,
    statusMessage,
    responseTypeName,
    responsePayloadBuffer: payload && type ? encodePayload(type, payload) : Buffer.alloc(0),
  };
}

function createAbsentStateGatewayService() {
  const types = {
    activeScheduleByTypeResponse: ABSENT_PROTO_ROOT.lookupType(
      "eve_public.payment.schedule.api.GetActiveByTypeResponse",
    ),
  };

  return {
    name: "assetholding-payments",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      if (requestTypeName === "eve_public.assetholding.asset.api.GetRequest") {
        return emptyAnswer(NOT_FOUND, "no such asset holding in this world",
          "eve_public.assetholding.asset.api.GetResponse");
      }

      if (requestTypeName === "eve_public.assetholding.entitlement.api.GetRequest") {
        return emptyAnswer(NOT_FOUND, "no such entitlement in this world",
          "eve_public.assetholding.entitlement.api.GetResponse");
      }

      if (requestTypeName === "eve_public.assetholding.entitlement.api.RedeemRequest") {
        return emptyAnswer(FAILED_PRECONDITION,
          "nothing was ever granted, so there is nothing to redeem",
          "eve_public.assetholding.entitlement.api.RedeemResponse");
      }

      if (requestTypeName === "eve_public.assetholding.entitlement.api.admin.ExpireRequest") {
        return emptyAnswer(NOT_FOUND, "no such entitlement in this world",
          "eve_public.assetholding.entitlement.api.admin.ExpireResponse");
      }

      if (requestTypeName === "eve_public.user.license.api.GetRequest") {
        // A user licence is an account-level grant (a ToS/EULA acceptance, a subscription) and this
        // world never issues one. NOT_FOUND is the answer the client's own messenger expects: it
        // treats 404 as "no user license found" and returns None. The default empty message it used
        // to receive instead built a licence whose last_modified was the epoch, i.e. a fake record.
        return emptyAnswer(NOT_FOUND, "no user licences exist in this world",
          "eve_public.user.license.api.GetResponse");
      }

      if (requestTypeName === "eve_public.payment.schedule.api.GetRequest") {
        // Measured in the owner's own log (2026-10-31 15:01:43): a 404 here is raised in the
        // client as an UNCAUGHT RequestException in a background tasklet, in the same second the
        // daily-goal page loads - and the daily-goal payment subsystem is what then refuses the
        // claim. The response carries one optional schedule, so the honest "no such schedule" is
        // a 200 with the field unset, which the client can read; a 404 it cannot.
        return emptyAnswer(200, "",
          "eve_public.payment.schedule.api.GetResponse");
      }

      if (requestTypeName === "eve_public.payment.schedule.api.GetActiveByTypeRequest") {
        // The response carries one optional schedule; leaving it unset is exactly
        // "there is no active schedule of this type", which is the truth here.
        return emptyAnswer(200, "",
          "eve_public.payment.schedule.api.GetActiveByTypeResponse", {}, types.activeScheduleByTypeResponse);
      }

      return emptyAnswer(FAILED_PRECONDITION,
        "code redemption is not configured on this world",
        "eve_public.payment.code.api.RedeemResponse");
    },
  };
}

module.exports = {
  ABSENT_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  createAbsentStateGatewayService,
};
