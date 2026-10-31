"use strict";
// Two small read surfaces that had no answer at all.
//
// `operation.recommendation.Get` asks which operations to recommend to the player. This world has
// no operations catalogue, so the honest answer is an empty recommendation list - not a made-up
// operation id that the client would then fail to resolve.
//
// `communitytrack.Get` asks for the progress of one community-track instance. There are no
// instances in this world, so an id nobody created is NOT_FOUND with the reason, rather than an
// empty progress that pretends the instance exists and is at zero.
const protobuf = require("protobufjs");

const RECOMMENDATION_API = "eve_public.operation.recommendation";
const COMMUNITY_API = "eve_public.communitytrack.api";
const ASSISTANT_API = "eve_public.ai.assistant.chat.api";

const SMALL_SURFACES_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        operation: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
            recommendation: {
              nested: {
                GetRequest: {
                  fields: {
                    amount: { type: "uint32", id: 1 },
                    allow_old: { type: "bool", id: 2 },
                  },
                },
                GetResponse: {
                  fields: {
                    operations_deprecated: {
                      rule: "repeated",
                      type: "eve_public.operation.Identifier",
                      id: 1,
                    },
                    operation_recommendations: {
                      rule: "repeated",
                      type: "eve_public.operation.recommendation.GetResponse.OperationRecommendation",
                      id: 4,
                    },
                  },
                  nested: {
                    OperationRecommendation: {
                      fields: {
                        operation: { type: "eve_public.operation.Identifier", id: 2 },
                        journey: { type: "uint32", id: 3 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        communitytrack: {
          nested: {
            instance: {
              nested: {
                Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
              },
            },
            api: {
              nested: {
                GetRequest: {
                  fields: {
                    instance: {
                      type: "eve_public.communitytrack.instance.Identifier",
                      id: 1,
                    },
                  },
                },
                GetResponse: { fields: {} },
              },
            },
          },
        },
        ai: {
          nested: {
            assistant: {
              nested: {
                chat: {
                  nested: {
                    api: {
                      nested: {
                        QueryRequest: { fields: { message: { type: "string", id: 1 } } },
                        QueryResponse: {
                          fields: {
                            response: { type: "string", id: 1 },
                            fallback: { type: "bool", id: 2 },
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

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.operation.recommendation.GetRequest",
  "eve_public.communitytrack.api.GetRequest",
  "eve_public.ai.assistant.chat.api.QueryRequest",
]);

function createSmallSurfacesGatewayService() {
  const types = {
    recommendationResponse: SMALL_SURFACES_PROTO_ROOT.lookupType(
      `${RECOMMENDATION_API}.GetResponse`,
    ),
  };

  return {
    name: "empty-catalogue-surfaces",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      if (requestTypeName === `${RECOMMENDATION_API}.GetRequest`) {
        const payload = types.recommendationResponse.encode(
          types.recommendationResponse.create({}),
        ).finish();
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: `${RECOMMENDATION_API}.GetResponse`,
          responsePayloadBuffer: Buffer.from(payload),
        };
      }

      if (requestTypeName === `${ASSISTANT_API}.QueryRequest`) {
        // Aura guidance answers with a formatted message produced by an AI service. This world
        // runs no such service and has no message to formulate, so the call is NOT_IMPLEMENTED
        // with the reason. Inventing a friendly "answer" would be a fabricated AI response.
        return {
          statusCode: 501,
          statusMessage: "this world has no AI assistant service",
          responseTypeName: `${ASSISTANT_API}.QueryResponse`,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }

      return {
        statusCode: 5,
        statusMessage: "no community track instance exists in this world",
        responseTypeName: `${COMMUNITY_API}.GetResponse`,
        responsePayloadBuffer: Buffer.alloc(0),
      };
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SMALL_SURFACES_PROTO_ROOT,
  createSmallSurfacesGatewayService,
};
