export interface TopicCard {
  readonly id: string
  readonly title: string
  readonly mechanism: string
  readonly valueRationale: string
  readonly difficulty: 'basic' | 'intermediate' | 'advanced'
  readonly evidenceIds: readonly string[]
  readonly evidenceNeeds: readonly string[]
  readonly unconfirmed: readonly string[]
}

export interface SelectionPlan {
  readonly selectedIds: readonly string[]
  readonly requiredBundles: readonly Readonly<{ id: string; evidenceIds: readonly string[] }>[]
  readonly unresolved: readonly string[]
}

export interface InvestigationResult {
  readonly strategy: 'scripted-static-v1' | 'bounded-agentic-v1'
  readonly status: 'completed' | 'insufficient-evidence' | 'limit-reached'
  readonly topics: readonly TopicCard[]
  readonly selection: SelectionPlan
  readonly stopReason: 'finished' | 'no-evidence' | 'no-progress' | 'decision-limit' | 'budget-exhausted' | 'invalid-action-limit'
  readonly statistics: Readonly<{
    decisions: number
    toolRequests: number
    repeatedReads: number
    invalidActions: number
    invalidToolExecutions: number
  }>
  readonly usageComplete: boolean
}
