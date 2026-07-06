export interface ModelPricing {
  /** Per-million-token rates, USD. */
  input: number;
  output: number;
  cache: {
    read: number;
    write: number;
  };
  /** Optional context-window tier pricing (e.g. Gemini >200K). */
  tiers?: Array<{
    tier: { type: 'context'; size: number };
    input: number;
    output: number;
    cache: { read: number; write: number };
  }>;
}

export interface PricingSource {
  /** Returns pricing for a model, or undefined if unknown. */
  resolve(providerId: string, modelId: string): Promise<ModelPricing | undefined>;
  /** Forces a refresh of cached pricing data. */
  refresh?(): Promise<void>;
}
