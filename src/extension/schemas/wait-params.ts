import { Type } from "typebox";
import { keepTopLevelParameterDescriptions } from "./pruning.ts";

const WaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({
		description: "Run id or prefix to wait for one specific run. Omit to wait across every active async run started in this session.",
	})),
	all: Type.Optional(Type.Boolean({
		description: "Wait for ALL active runs to finish. Default false: return as soon as the first run finishes, so a fleet manager can spawn a replacement and wait again. Ignored when id targets a single run.",
	})),
	timeoutMs: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Give up waiting after this many milliseconds (the runs keep going regardless). Defaults to 1800000 (30 minutes).",
	})),
});

export const WaitParams = keepTopLevelParameterDescriptions(WaitParamsSchema);
