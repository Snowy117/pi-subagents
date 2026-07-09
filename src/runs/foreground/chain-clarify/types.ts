/**
 * Chain-clarification type definitions.
 *
 * Grouped here so the component and editor submodules share one source of
 * truth. Only `BehaviorOverride` and `ChainClarifyResult` are re-exported by
 * the barrel; `ClarifyMode` and `EditMode` are internal sub-module types.
 */

export type ClarifyMode = 'single' | 'parallel' | 'chain';

export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;
	skills?: string[] | false;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	behaviorOverrides: (BehaviorOverride | undefined)[];
	runInBackground?: boolean;
}

export type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";
