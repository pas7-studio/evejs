"use strict";
// eve_public.dailygoal.api - the cards the client already knows how to draw.
//
// The client asks for the current goals, formats each one (name/description ids,
// contribution type, target, active window, rewards) and shows a progress bar with
// a redeem button. Stock answered an empty list, so the page was blank.
//
// The data comes from space/coopDailyGoals, which measures every goal from a real
// record (mining ledger, killmail ledger, accepted stargate jumps, goals actually
// redeemed). This file only translates that into the client's protobuf: it invents
// no progress and mints no ISK - the reward is skill points, granted on redeem.
//
// Messages are declared in a private root: the shared local gateway root does not
// carry eve_public.dailygoal.* and an eager lookupType() on a missing type throws at
// require time, which would take the whole gateway down.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");

const DAILY_GOAL_PROTO_ROOT = protobuf.Root.fromJSON({
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
        localization: {
          nested: {
            message: {
              nested: {
                Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
              },
            },
          },
        },
        character: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        corporation: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        assetholding: {
          nested: {
            asset: {
              nested: {
                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
              },
            },
          },
        },
        dailygoal: {
          nested: {
            Category: {
              values: {
                CATEGORY_UNSPECIFIED: 0,
                CATEGORY_DAILY: 1,
                CATEGORY_DAILY_BONUS: 2,
                CATEGORY_MONTHLY_BONUS: 3,
              },
            },
            PaymentPeriod: {
              values: {
                PAYMENT_PERIOD_UNSPECIFIED: 0,
                PAYMENT_PERIOD_COMPLETION: 1,
              },
            },
            Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
            Attributes: {
              fields: {
                name_message: { type: "eve_public.localization.message.Identifier", id: 1 },
                description_message: { type: "eve_public.localization.message.Identifier", id: 2 },
                help_text_message: { type: "eve_public.localization.message.Identifier", id: 3 },
                assigner: { type: "eve_public.corporation.Identifier", id: 4 },
                category: { type: "Category", id: 5 },
                contribution_configuration: { type: "ContributionConfiguration", id: 6 },
                career: { type: "eve_public.career.Path", id: 7 },
                payment: { rule: "repeated", type: "Payment", id: 8 },
                target: { type: "uint64", id: 9 },
                active_after: { type: "google.protobuf.Timestamp", id: 10 },
                active_until: { type: "google.protobuf.Timestamp", id: 11 },
                omega: { type: "bool", id: 12 },
              },
            },
            Payment: {
              fields: {
                asset: { type: "eve_public.assetholding.asset.Identifier", id: 1 },
                period: { type: "PaymentPeriod", id: 2 },
                unit: { type: "Unit", id: 3 },
              },
            },
            Unit: {
              fields: {
                isk: { type: "InterStellarKredits", id: 1 },
                lp: { type: "LoyaltyPoints", id: 2 },
                sp: { type: "SkillPoints", id: 3 },
                item: { type: "Item", id: 5 },
                plex: { type: "Plex", id: 6 },
              },
            },
            InterStellarKredits: {
              fields: { amount: { type: "eve_public.isk.Currency", id: 1 } },
            },
            IskCurrency: {
              fields: { units: { type: "sint64", id: 1 }, nanos: { type: "sint32", id: 2 } },
            },
            LoyaltyPoints: {
              fields: { amount: { type: "eve_public.loyaltypoints.Currency", id: 1 } },
            },
            SkillPoints: { fields: { amount: { type: "uint32", id: 1 } } },
            Item: {
              fields: {
                amount: { type: "uint32", id: 1 },
                type: { type: "eve_public.inventory.genericitemtype.Identifier", id: 2 },
              },
            },
            Plex: {
              fields: { amount: { type: "eve_public.plex.Currency", id: 1 } },
            },
            // Only the branches our measured goals use are declared; a goal is
            // refused unless one of them is set, exactly like the client refuses a
            // goal whose configuration it does not recognise.
            ContributionConfiguration: {
              fields: {
                kill_npc: { type: "MatcherList", id: 1 },
                mine_ore: { type: "MatcherList", id: 3 },
                install_manufacturing_job: { type: "MatcherList", id: 9 },
                complete_daily_goal: { type: "MatcherList", id: 10 },
                space_jump: { type: "EmptyConfig", id: 13 },
              },
            },
            MatcherList: {
              fields: { contribution_methods: { rule: "repeated", type: "bytes", id: 1 } },
            },
            EmptyConfig: { fields: {} },
            Earning: {
              fields: { unit: { type: "Unit", id: 1 }, omega_required: { type: "bool", id: 2 } },
            },
            api: {
              nested: {
                Goal: {
                  fields: {
                    id: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    goal: { type: "eve_public.dailygoal.Attributes", id: 2 },
                    current_progress: { type: "uint64", id: 3 },
                    entitlements: {
                      rule: "repeated",
                      type: "eve_public.assetholding.asset.Identifier",
                      id: 4,
                    },
                    earnings: {
                      rule: "repeated",
                      type: "eve_public.dailygoal.Earning",
                      id: 5,
                    },
                    paid_completion: { type: "bool", id: 6 },
                  },
                },
                GetAllCurrentRequest: { fields: {} },
                GetAllCurrentResponse: {
                  fields: { goals: { rule: "repeated", type: "Goal", id: 1 } },
                },
                GetAllWithRewardsRequest: { fields: {} },
                GetAllWithRewardsResponse: {
                  fields: { ids: { rule: "repeated", type: "eve_public.dailygoal.Identifier", id: 1 } },
                },
                GetRequest: {
                  fields: { goal: { type: "eve_public.dailygoal.Identifier", id: 1 } },
                },
                GetResponse: {
                  fields: {
                    goal: { type: "eve_public.dailygoal.Attributes", id: 1 },
                    progress: { type: "uint64", id: 2 },
                    entitlements: {
                      rule: "repeated",
                      type: "eve_public.assetholding.asset.Identifier",
                      id: 3,
                    },
                    earnings: {
                      rule: "repeated",
                      type: "eve_public.dailygoal.Earning",
                      id: 4,
                    },
                  },
                },
                RedeemRequest: {
                  fields: {
                    goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                    redeem_current_location: { type: "bool", id: 2 },
                  },
                },
                RedeemResponse: { fields: {} },
                // The client subscribes to this and switches the card to "claimed" when it
                // arrives; without it the window only catches up on the next reload.
                RedeemedNotice: {
                  fields: { goal: { type: "eve_public.dailygoal.Identifier", id: 1 } },
                },
                PayForCompletionRequest: {
                  fields: { goal: { type: "eve_public.dailygoal.Identifier", id: 1 } },
                },
                PayForCompletionResponse: { fields: {} },
                admin: {
                  nested: {
                    ProgressRequest: {
                      fields: {
                        goal: { type: "eve_public.dailygoal.Identifier", id: 1 },
                        character: { type: "eve_public.character.Identifier", id: 2 },
                        progress: { type: "uint64", id: 3 },
                      },
                    },
                    ProgressResponse: { fields: {} },
                  },
                },
              },
            },
          },
        },
        career: {
          nested: {
            Path: {
              values: {
                CAREER_UNSPECIFIED: 0,
                CAREER_EXPLORATION: 1,
                CAREER_INDUSTRIALIST: 2,
                CAREER_ENFORCER: 3,
                CAREER_SOLDIER_OF_FORTUNE: 4,
              },
            },
          },
        },
        isk: {
          nested: {
            Currency: {
              fields: { units: { type: "sint64", id: 1 }, nanos: { type: "sint32", id: 2 } },
            },
          },
        },
        loyaltypoints: {
          nested: { Currency: { fields: { amount: { type: "uint64", id: 1 } } } },
        },
        plex: {
          nested: { Currency: { fields: { total_in_cents: { type: "uint64", id: 1 } } } },
        },
        inventory: {
          nested: {
            genericitemtype: {
              nested: {
                Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
              },
            },
          },
        },
      },
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.dailygoal.api.GetAllCurrentRequest",
  "eve_public.dailygoal.api.GetAllWithRewardsRequest",
  "eve_public.dailygoal.api.GetRequest",
  "eve_public.dailygoal.api.RedeemRequest",
  "eve_public.dailygoal.api.PayForCompletionRequest",
  "eve_public.dailygoal.api.admin.ProgressRequest",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function timestampOf(ms) {
  const seconds = Math.floor(Number(ms) / 1000);
  return { seconds, nanos: Math.round((Number(ms) % 1000) * 1e6) };
}

function buildAttributesPayload(definition, dayStart, corporationID, rewardSkillPoints) {
  const configuration = {};
  if (definition.kind === "kill_npc") configuration.kill_npc = {};
  else if (definition.kind === "mine_ore") configuration.mine_ore = {};
  else if (definition.kind === "install_manufacturing_job") {
    configuration.install_manufacturing_job = {};
  } else if (definition.kind === "complete_daily_goal") configuration.complete_daily_goal = {};
  else if (definition.kind === "space_jump") configuration.space_jump = {};

  return {
    name_message: { sequential: definition.nameID },
    description_message: { sequential: definition.descriptionID },
    help_text_message: { sequential: definition.helpTextID },
    assigner: { sequential: Number(corporationID) || 0 },
    category: definition.category,
    contribution_configuration: configuration,
    career: definition.career,
    payment: [
      {
        // The reward pool is the goal itself: the client needs a 16 byte asset id
        // and uuid.UUID(bytes=...) raises on an empty one, which would drop the card.
        asset: { uuid: uuidStringToBuffer(definition.goalID) },
        period: 1, // PAYMENT_PERIOD_COMPLETION
        unit: { sp: { amount: rewardSkillPoints } },
      },
    ],
    target: definition.target,
    active_after: timestampOf(dayStart),
    active_until: timestampOf(dayStart + DAY_MS),
    omega: false,
  };
}

function buildGoalPayload(entry, corporationID, nowMs) {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  // The card must promise exactly what redeem pays: the module computes the reward
  // from the real progress (bigger hulls, more points, more SP).
  const rewardSkillPoints = Number(entry.rewardSkillPoints) ||
    Number(entry.definition.rewardSkillPoints);
  const attributes = buildAttributesPayload(
    entry.definition,
    dayStart,
    corporationID,
    rewardSkillPoints,
  );
  return {
    id: { uuid: uuidStringToBuffer(entry.definition.goalID) },
    goal: attributes,
    current_progress: entry.progress,
    // A completed but unredeemed goal carries its earning so the client offers
    // "Redeem"; before that there is nothing earned yet, which is the truth.
    earnings: entry.completed && !entry.claimedAt
      ? [{ unit: { sp: { amount: rewardSkillPoints } }, omega_required: false }]
      : [],
    paid_completion: false,
  };
}

function createDailyGoalGatewayService(context = {}) {
  const dailyGoals = context.dailyGoals || require(path.join(
    __dirname,
    "../../../space/coopDailyGoals",
  )).shared();
  const types = {
    getAllCurrentResponse: DAILY_GOAL_PROTO_ROOT.lookupType(
      "eve_public.dailygoal.api.GetAllCurrentResponse",
    ),
    getAllWithRewardsResponse: DAILY_GOAL_PROTO_ROOT.lookupType(
      "eve_public.dailygoal.api.GetAllWithRewardsResponse",
    ),
    getRequest: DAILY_GOAL_PROTO_ROOT.lookupType("eve_public.dailygoal.api.GetRequest"),
    getResponse: DAILY_GOAL_PROTO_ROOT.lookupType("eve_public.dailygoal.api.GetResponse"),
    redeemRequest: DAILY_GOAL_PROTO_ROOT.lookupType("eve_public.dailygoal.api.RedeemRequest"),
    payRequest: DAILY_GOAL_PROTO_ROOT.lookupType(
      "eve_public.dailygoal.api.PayForCompletionRequest",
    ),
    progressRequest: DAILY_GOAL_PROTO_ROOT.lookupType(
      "eve_public.dailygoal.api.admin.ProgressRequest",
    ),
    redeemedNotice: DAILY_GOAL_PROTO_ROOT.lookupType(
      "eve_public.dailygoal.api.RedeemedNotice",
    ),
  };

  // The client's daily-goal messenger subscribes to RedeemedNotice (dailygoals/client/
  // goalMessenger.pyj). Publishing it after a real redeem is what makes the card update
  // instead of waiting for the next page load.
  function publishRedeemed(characterID, goalID) {
    if (typeof context.publishGatewayNotice !== "function") return;
    context.publishGatewayNotice(
      "eve_public.dailygoal.api.RedeemedNotice",
      encodePayload(types.redeemedNotice, {
        goal: { uuid: uuidStringToBuffer(goalID) },
      }),
      { character: Number(characterID) || 0 },
    );
  }

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  function goalIDOf(identifier) {
    return identifier && identifier.uuid ? uuidBufferToString(identifier.uuid) : "";
  }

  function corporationIDOf(characterID) {
    try {
      const read = require(path.join(__dirname, "../../../gameStore")).read(
        "characters",
        "/",
      );
      const record = read && read.success && read.data
        ? read.data[String(characterID)]
        : null;
      return Number(record && record.corporationID) || 0;
    } catch (_error) {
      return 0;
    }
  }

  function error(statusCode, message, responseTypeName) {
    return {
      statusCode,
      statusMessage: message,
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "daily-goals",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const characterID = Number(getActiveCharacterID(requestEnvelope) || 0);
      const nowMs = Date.now();
      const snapshot = dailyGoals.snapshotFor(characterID, nowMs);
      const corporationID = characterID ? corporationIDOf(characterID) : 0;

      if (requestTypeName === "eve_public.dailygoal.api.GetAllCurrentRequest") {
        if (snapshot.status === "DISABLED") {
          // A disabled feature is an empty list, never a fake goal.
          return {
            statusCode: 200,
            statusMessage: "",
            responseTypeName: "eve_public.dailygoal.api.GetAllCurrentResponse",
            responsePayloadBuffer: encodePayload(types.getAllCurrentResponse, { goals: [] }),
          };
        }
        if (snapshot.status !== "OBSERVED") {
          return error(9, "daily goals need an active character session",
            "eve_public.dailygoal.api.GetAllCurrentResponse");
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.dailygoal.api.GetAllCurrentResponse",
          responsePayloadBuffer: encodePayload(types.getAllCurrentResponse, {
            goals: snapshot.goals.map((entry) => buildGoalPayload(entry, corporationID, nowMs)),
          }),
        };
      }

      if (requestTypeName === "eve_public.dailygoal.api.GetAllWithRewardsRequest") {
        const ids = snapshot.status === "OBSERVED" ? snapshot.goals : [];
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.dailygoal.api.GetAllWithRewardsResponse",
          responsePayloadBuffer: encodePayload(types.getAllWithRewardsResponse, {
            ids: ids.map((entry) => ({
              uuid: uuidStringToBuffer(entry.definition.goalID),
            })),
          }),
        };
      }

      if (requestTypeName === "eve_public.dailygoal.api.GetRequest") {
        const goalID = goalIDOf(decode(types.getRequest, requestEnvelope).goal);
        const entry = (snapshot.goals || []).find(
          (candidate) => candidate.definition.goalID === goalID,
        );
        if (!entry) return error(5, "unknown daily goal", "eve_public.dailygoal.api.GetResponse");
        const built = buildGoalPayload(entry, corporationID, nowMs);
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.dailygoal.api.GetResponse",
          responsePayloadBuffer: encodePayload(types.getResponse, {
            goal: built.goal,
            progress: built.current_progress,
            earnings: built.earnings,
          }),
        };
      }

      if (requestTypeName === "eve_public.dailygoal.api.RedeemRequest") {
        const goalID = goalIDOf(decode(types.redeemRequest, requestEnvelope).goal);
        const result = dailyGoals.redeem(characterID, goalID, nowMs);
        if (result.status === "REDEEMED") {
          publishRedeemed(characterID, goalID);
          return {
            statusCode: 200,
            statusMessage: "",
            responseTypeName: "eve_public.dailygoal.api.RedeemResponse",
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        const responseTypeName = "eve_public.dailygoal.api.RedeemResponse";
        if (result.status === "ALREADY_CLAIMED") return error(9, "goal already redeemed", responseTypeName);
        if (result.status === "NOT_COMPLETED") {
          return error(9, `goal is not complete (${result.progress}/${result.target})`, responseTypeName);
        }
        return error(13, `goal could not be redeemed: ${result.status}`, responseTypeName);
      }

      if (requestTypeName === "eve_public.dailygoal.api.PayForCompletionRequest") {
        // Paying ISK to finish a goal would mint money or spend it without a
        // funded account; the co-op world has neither, so this is honestly refused.
        return error(12, "paying to complete a daily goal is not available",
          "eve_public.dailygoal.api.PayForCompletionResponse");
      }

      // dailygoal.api.admin.ProgressRequest - the QA knob the client itself uses.
      const request = decode(types.progressRequest, requestEnvelope);
      const goalID = goalIDOf(request.goal);
      const targetCharacterID = Number(request.character && request.character.sequential) ||
        characterID;
      const result = dailyGoals.recordManualProgress(
        goalID,
        targetCharacterID,
        Number(request.progress) || 0,
        nowMs,
      );
      if (result.status === "RECORDED") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.dailygoal.api.admin.ProgressResponse",
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }
      return error(9, `progress was not recorded: ${result.status}`,
        "eve_public.dailygoal.api.admin.ProgressResponse");
    },
  };
}

module.exports = {
  DAILY_GOAL_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  buildAttributesPayload,
  buildGoalPayload,
  createDailyGoalGatewayService,
};
