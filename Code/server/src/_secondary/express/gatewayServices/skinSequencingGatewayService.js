"use strict";
// eve_public...sequencing.job.api.*: the jobs that turn a design into a third-party skin.
//
// GetAllActive / Get / Initiate / CompleteEarly all read and write the rows owned by
// space/coopSkinSequencing. Initiate is the only creator, and it pays before the job exists:
// every component licence is validated first and then spent, and `licenses` is the number of
// copies the job will mint. A due job completes on read, so a restart cannot lose it.
//
// The layout is taken off the wire verbatim (field 3) for the same reason as the drafts: the
// design tree contains nested configuration messages this build does not model, and re-encoding
// a partly decoded tree would drop them.
//
// GetAllActive used to be answered with an empty list by the compatibility service; a job that
// is really running is no longer invisible.
const path = require("path");
const protobuf = require("protobufjs");

const {
  durationFromMs,
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");
const { rawLayoutField } = require("./thirdPartySkinDraftGatewayService");

const JOB = "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job";
const JOB_API = `${JOB}.api`;
const QUOTE_API = "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api";
const COMPONENT = "eve_public.cosmetic.ship.skin.thirdparty.component";
// A design's tier level is computed by the client from its own threshold table and is not
// something the server can observe. The world charges no PLEX for any tier and runs one fixed
// duration for every job, so the table is the same true answer for every level; it is published
// for 1..10 because the client indexes the answer by the design's level and a missing key would
// break the window, while an extra key just repeats the same truth.
const QUOTE_TIER_LEVELS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const SEQUENCING_PROTO_ROOT = protobuf.Root.fromJSON({
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
            Duration: {
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
        character: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        plex: {
          nested: {
            Currency: { fields: { total_in_cents: { type: "uint64", id: 1 } } },
          },
        },
        cosmetic: {
          nested: {
            ship: {
              nested: {
                skin: {
                  nested: {
                    thirdparty: {
                      nested: {
                        Identifier: { fields: { hex: { type: "string", id: 1 } } },
                        Tier: { fields: { level: { type: "uint32", id: 1 } } },
                        component: {
                          nested: {
                            coating: {
                              nested: {
                                Identifier: {
                                  fields: { sequential: { type: "uint64", id: 1 } },
                                },
                              },
                            },
                            Identifier: {
                              fields: {
                                coating: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.coating.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            license: {
                              nested: {
                                Kind: {
                                  fields: {
                                    component: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.component.Identifier",
                                      id: 1,
                                    },
                                    infinite: { type: "bool", id: 2 },
                                    finite: { type: "uint64", id: 3 },
                                  },
                                },
                              },
                            },
                          },
                        },
                        sequencing: {
                          nested: {
                            job: {
                              nested: {
                                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                                Attributes: {
                                  fields: {
                                    skin: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                                      id: 1,
                                    },
                                    sequencer: {
                                      type: "eve_public.character.Identifier",
                                      id: 2,
                                    },
                                    quantity: { type: "uint64", id: 3 },
                                    pending: { type: "bool", id: 4 },
                                    started: { type: "google.protobuf.Timestamp", id: 5 },
                                    completed: { type: "google.protobuf.Timestamp", id: 7 },
                                    planned_completion: {
                                      type: "google.protobuf.Timestamp",
                                      id: 8,
                                    },
                                  },
                                },
                                api: {
                                  nested: {
                                    GetAllActiveRequest: { fields: {} },
                                    GetAllActiveResponse: {
                                      fields: {
                                        jobs: {
                                          rule: "repeated",
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.api.GetAllActiveResponse.Job",
                                          id: 1,
                                        },
                                      },
                                      nested: {
                                        Job: {
                                          fields: {
                                            id: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Identifier",
                                              id: 1,
                                            },
                                            attributes: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Attributes",
                                              id: 2,
                                            },
                                          },
                                        },
                                      },
                                    },
                                    GetRequest: {
                                      fields: {
                                        job: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Identifier",
                                          id: 1,
                                        },
                                      },
                                    },
                                    GetResponse: {
                                      fields: {
                                        job: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Attributes",
                                          id: 1,
                                        },
                                      },
                                    },
                                    InitiateRequest: {
                                      fields: {
                                        name: { type: "string", id: 1 },
                                        line_name: { type: "string", id: 2 },
                                        component_licenses: {
                                          rule: "repeated",
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.Kind",
                                          id: 4,
                                        },
                                        licenses: { type: "uint32", id: 5 },
                                      },
                                    },
                                    InitiateResponse: {
                                      fields: {
                                        id: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Identifier",
                                          id: 1,
                                        },
                                        attributes: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Attributes",
                                          id: 2,
                                        },
                                      },
                                    },
                                    CompleteEarlyRequest: {
                                      fields: {
                                        job: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.Identifier",
                                          id: 1,
                                        },
                                      },
                                    },
                                    CompleteEarlyResponse: { fields: {} },
                                  },
                                },
                              },
                            },
                        // The quotes the client asks for before the sequencing window opens.
                        // This world charges no PLEX for sequencing - the price is paid in
                        // component licences, spent by Initiate - and every job runs the store's
                        // one fixed duration. So every tier answers "0 PLEX" and that duration.
                        api: {
                          nested: {
                            GetTierPricingRequest: { fields: {} },
                            GetTierPricingResponse: {
                              fields: {
                                prices: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetTierPricingResponse.Price",
                                  id: 1,
                                },
                                discount_percentage_applied: { type: "uint32", id: 2 },
                              },
                              nested: {
                                Price: {
                                  fields: {
                                    tier: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.Tier",
                                      id: 1,
                                    },
                                    plex: { type: "eve_public.plex.Currency", id: 2 },
                                  },
                                },
                              },
                            },
                            GetTierDurationsRequest: { fields: {} },
                            GetTierDurationsResponse: {
                              fields: {
                                durations: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetTierDurationsResponse.Duration",
                                  id: 1,
                                },
                                discount_percentage_applied: { type: "uint32", id: 2 },
                              },
                              nested: {
                                Duration: {
                                  fields: {
                                    tier: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.Tier",
                                      id: 1,
                                    },
                                    duration: { type: "google.protobuf.Duration", id: 2 },
                                  },
                                },
                              },
                            },
                            GetEarlyCompletionPricingRequest: { fields: {} },
                            GetEarlyCompletionPricingResponse: {
                              fields: {
                                prices: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetEarlyCompletionPricingResponse.Price",
                                  id: 1,
                                },
                              },
                              nested: {
                                Price: {
                                  fields: {
                                    remaining_greater: {
                                      type: "google.protobuf.Duration",
                                      id: 1,
                                    },
                                    remaining_lesser_or_equal: {
                                      type: "google.protobuf.Duration",
                                      id: 2,
                                    },
                                    plex: { type: "eve_public.plex.Currency", id: 3 },
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
        },
      },
    },
  },
});

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.api.InitiateRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.api.GetRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.api.GetAllActiveRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.job.api.CompleteEarlyRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetTierPricingRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetTierDurationsRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.sequencing.api.GetEarlyCompletionPricingRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function jobAttributes(job) {
  const attributes = {
    sequencer: { sequential: 0 },
    quantity: Math.max(0, Number(job.quantity) || 0),
    pending: job.pending !== false,
    started: timestampOf(job.startedMs),
    planned_completion: timestampOf(job.plannedMs),
  };
  if (job.skinHex) attributes.skin = { hex: String(job.skinHex) };
  const completed = timestampOf(job.completedMs);
  if (completed) attributes.completed = completed;
  return attributes;
}

// A decoded component_licenses entry is {component:{coating:{sequential}}, infinite, finite};
// the store wants the plain component number, which is also what the tests pass in.
function kindOf(kind) {
  const component = kind && kind.component;
  const raw = component && typeof component === "object"
    ? component.coating && component.coating.sequential
    : component;
  // uint64 decodes as a Long, which Number() cannot convert by itself.
  const sequential = Number(raw && typeof raw.toNumber === "function" ? raw.toNumber() : raw) || 0;
  return {
    component: sequential,
    infinite: kind && kind.infinite === true,
    finite: Math.max(0, Number(kind && kind.finite) || 0),
  };
}

function createSkinSequencingGatewayService(context = {}) {
  const sequencing = context.skinSequencing || require(path.join(
    __dirname,
    "../../../space/coopSkinSequencing",
  )).shared();
  const types = {
    getAllActiveResponse: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.GetAllActiveResponse`),
    getRequest: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.GetRequest`),
    getResponse: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.GetResponse`),
    initiateRequest: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.InitiateRequest`),
    initiateResponse: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.InitiateResponse`),
    completeEarlyRequest: SEQUENCING_PROTO_ROOT.lookupType(`${JOB_API}.CompleteEarlyRequest`),
    tierPricingResponse: SEQUENCING_PROTO_ROOT.lookupType(`${QUOTE_API}.GetTierPricingResponse`),
    tierDurationsResponse: SEQUENCING_PROTO_ROOT.lookupType(`${QUOTE_API}.GetTierDurationsResponse`),
    earlyCompletionPricingResponse: SEQUENCING_PROTO_ROOT.lookupType(
      `${QUOTE_API}.GetEarlyCompletionPricingResponse`,
    ),
  };

  function payloadOf(requestEnvelope) {
    return (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
      Buffer.alloc(0);
  }

  function decode(type, requestEnvelope) {
    return type.decode(payloadOf(requestEnvelope));
  }

  function error(statusCode, message, responseTypeName) {
    return {
      statusCode,
      statusMessage: message,
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  function ok(responseTypeName, type = null, payload = null) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: type ? encodePayload(type, payload || {}) : Buffer.alloc(0),
    };
  }

  function jobIdentifier(job) {
    return { uuid: Buffer.from(String(job.uuid || ""), "hex") };
  }

  function refusalFor(result, responseTypeName) {
    const refusals = {
      QUANTITY_INVALID: [3, "the number of copies must be between 1 and 100"],
      LAYOUT_REQUIRED: [3, "a design is required"],
      COMPONENT_REQUIRED: [3, "a component id is required"],
      LICENCE_NOT_FOUND: [5, `no licence for component ${result.component || ""}`.trim()],
      NOT_ENOUGH_CAPACITY: [9,
        `component ${result.component || ""} has ${result.remaining || 0} capacity left`.trim()],
      SPEND_FAILED: [13, `the licence could not be spent: ${result.reason || ""}`],
      UUID_REQUIRED: [3, "a job id is required"],
      NOT_FOUND: [5, "no such sequencing job"],
      NOT_PENDING: [9, "that job is not pending"],
      NO_CHARACTER: [7, "no character in this session"],
      WRITE_FAILED: [13, "the job could not be stored"],
      UUID_FAILED: [13, "a job id could not be assigned"],
    };
    const refusal = refusals[result.status] || [13, `sequencing failed: ${result.status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "skins-sequencing-jobs",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${JOB_API}.GetAllActiveRequest`) {
        return ok(`${JOB_API}.GetAllActiveResponse`, types.getAllActiveResponse, {
          jobs: sequencing.list(activeCharacterID).map((job) => ({
            id: jobIdentifier(job),
            attributes: jobAttributes(job),
          })),
        });
      }

      if (requestTypeName === `${JOB_API}.GetRequest`) {
        const decoded = decode(types.getRequest, requestEnvelope);
        const job = sequencing.get(activeCharacterID, decoded && decoded.job && decoded.job.uuid);
        if (!job) return error(5, "no such sequencing job", `${JOB_API}.GetResponse`);
        const attributes = jobAttributes(job);
        attributes.sequencer = { sequential: activeCharacterID };
        return ok(`${JOB_API}.GetResponse`, types.getResponse, { job: attributes });
      }

      if (requestTypeName === `${JOB_API}.InitiateRequest`) {
        const payload = payloadOf(requestEnvelope);
        const decoded = decode(types.initiateRequest, requestEnvelope);
        const result = sequencing.initiate(activeCharacterID, {
          name: decoded && decoded.name,
          lineName: decoded && decoded.line_name,
          layout: rawLayoutField(payload, 3),
          kinds: ((decoded && decoded.component_licenses) || []).map(kindOf),
          quantity: Number(decoded && decoded.licenses) || 0,
        });
        if (result.status !== "STARTED") {
          return refusalFor(result, `${JOB_API}.InitiateResponse`);
        }
        const attributes = jobAttributes(result.job);
        attributes.sequencer = { sequential: activeCharacterID };
        return ok(`${JOB_API}.InitiateResponse`, types.initiateResponse, {
          id: jobIdentifier(result.job),
          attributes,
        });
      }

      if (requestTypeName === `${QUOTE_API}.GetTierPricingRequest`) {
        // Measured: nothing is charged in PLEX. The price of a sequencing job in this world is
        // component licences, and Initiate spends them before the job exists.
        return ok(`${QUOTE_API}.GetTierPricingResponse`, types.tierPricingResponse, {
          prices: QUOTE_TIER_LEVELS.map((level) => ({
            tier: { level },
            plex: { total_in_cents: 0 },
          })),
          discount_percentage_applied: 0,
        });
      }

      if (requestTypeName === `${QUOTE_API}.GetTierDurationsRequest`) {
        // The duration the store will really use, not a nominal one: the client shows this
        // number and the job completes when that much time has passed.
        const duration = durationFromMs(sequencing.durationMs());
        return ok(`${QUOTE_API}.GetTierDurationsResponse`, types.tierDurationsResponse, {
          durations: QUOTE_TIER_LEVELS.map((level) => ({
            tier: { level },
            duration,
          })),
          discount_percentage_applied: 0,
        });
      }

      if (requestTypeName === `${QUOTE_API}.GetEarlyCompletionPricingRequest`) {
        // CompleteEarly charges nothing, so the expedite price is zero for every remaining time
        // up to a whole job. One window covers that: remaining > 0 and <= the job's duration.
        return ok(
          `${QUOTE_API}.GetEarlyCompletionPricingResponse`,
          types.earlyCompletionPricingResponse,
          {
            prices: [{
              remaining_greater: { seconds: 0, nanos: 0 },
              remaining_lesser_or_equal: durationFromMs(sequencing.durationMs()),
              plex: { total_in_cents: 0 },
            }],
          },
        );
      }

      const decoded = decode(types.completeEarlyRequest, requestEnvelope);
      const result = sequencing.completeEarly(
        activeCharacterID,
        decoded && decoded.job && decoded.job.uuid,
      );
      if (result.status !== "COMPLETED") {
        return refusalFor(result, `${JOB_API}.CompleteEarlyResponse`);
      }
      return ok(`${JOB_API}.CompleteEarlyResponse`);
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SEQUENCING_PROTO_ROOT,
  createSkinSequencingGatewayService,
  jobAttributes,
  kindOf,
};
