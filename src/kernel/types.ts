import type {Spirit} from './spirit.js';
export type EvidenceLevel = 'observed' | 'verified' | 'reported' | 'inferred' | 'fictional';
export type ActionStatus = 'PROPOSED' | 'VALIDATED' | 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface LifeEvent { eventId: string; petId: string; type: string; source: string; actorId?: string; occurredAt: string; receivedAt: string; payload: unknown; causationId?: string; correlationId?: string; evidenceLevel: EvidenceLevel }
export interface Body { energy: number; stamina: number; hunger: number; hydration: number; comfort: number; pain: number; sleeping: boolean; restrained: boolean; injured: boolean }
export interface Emotions { joy: number; sadness: number; anger: number; fear: number; love: number; aversion: number; longing: number; curiosity: number; loneliness: number }
export interface Goal { id: string; title: string; kind: string; priority: number; urgency: number; status: 'active' | 'paused' | 'deferred' | 'completed' | 'failed' | 'abandoned'; parentId?: string; review?: GoalReview; mergedInto?:string; completion?: {type:'read-url';url:string}|{type:'stages';count?:number}; research?:boolean; sourceIds: string[] }
export interface GoalReview { at: string; reason: string; conditions: string }
export interface Commitment { id: string; description: string; status: 'open' | 'fulfilled' | 'broken' | 'cancelled'; dueAt?: string; actionId?:string; sourceIds: string[] }
export interface Memory { feeling?:string; salience?:number; id: string; kind: 'episodic' | 'semantic' | 'procedural' | 'autobiographical' | 'social' | 'commitment'; content: string; sourceIds: string[]; evidenceLevel: EvidenceLevel; valid: boolean; createdAt: string; correctedBy?: string }
export interface Belief { id: string; subject: string; value: string; confidence: number; sourceIds: string[]; valid: boolean }
export interface StrategyObservation { id: string; strategy: string; context: string; success: boolean; sourceIds: string[]; valid: boolean; work?:{contractId:string; observedAt:string} }
export interface Relationship { personId: string; familiarity: number; trust: number; sourceIds: string[]; openCommitments?: number; outstandingWages?: number }
export interface BodyLimits { allowSleeping?: boolean; allowRestrained?: boolean; allowInjured?: boolean; maxPain?: number; minStamina?: number }
export interface Capability { name: string; enabled: boolean; requiresPermission?: string; physical?: boolean; bodyLimits?: BodyLimits }
export interface DevelopmentRecord { id: string; label: string; value: string; sourceIds: string[]; valid: boolean }
export interface SelfModel { personality: DevelopmentRecord[]; preferences: DevelopmentRecord[]; abilities: DevelopmentRecord[]; limitations: DevelopmentRecord[]; values: DevelopmentRecord[]; interests: DevelopmentRecord[]; habits: DevelopmentRecord[]; autobiography: DevelopmentRecord[] }
export interface WorldFact extends DevelopmentRecord {
  topic?: 'farm.weather'|'farm.tended'|'farm.settled';
  observedAt?: string;
  day?: string;
  validUntil?: string;
  data?: Record<string,unknown>;
}
export interface WorldModel { facts: WorldFact[] }
export interface RuntimeConstraints { paused: boolean; permissions: string[]; capabilities: Capability[]; remainingBudget: number; budgetDay?:string; interactiveRemaining?:number|null }
export interface ActionProposal { id: string; petId: string; actionType: string; parameters: Record<string, unknown>; priority: number; interruptPolicy: 'interruptible' | 'safe-point' | 'noninterruptible'; requiredCapabilities: string[]; expectedStateVersion: number; sourceIds: string[]; goalId?: string }
export interface LifeAction extends ActionProposal { autonomous?:boolean; status: ActionStatus; createdAt: string; updatedAt: string; receiptId?: string }
export interface ActionReceipt { receiptId: string; petId: string; actionId: string; status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'; occurredAt: string; source: string; evidenceLevel: 'observed' | 'verified'; details: Record<string, unknown> }
export interface LegacyCognitiveContext { proactiveContact?:{balance:number;sentencePrice:number;maxSentences:number;intervalSeconds:number}; companion?:unknown; farm?:{operation:string|null}; labor?:unknown; laborPayment?:{overdueAmount:number}; worksite?:unknown; personaDescription: string; traits: unknown; interests: unknown; skills: unknown[]; strategies: unknown[]; attempts: unknown[] }
export interface CognitivePlanStep { id:string; actionType:string; parameters:Record<string,unknown>; goalId?:string; description:string; requiredCapabilities:string[]; sourceIds:string[]; status:'pending'|'in_progress'|'awaiting_receipt'|'completed'|'failed'; actionId?:string; receiptEventId?:string; readSearchResult?:boolean }
export interface CognitivePlan { id:string; goalId?:string; reviewReason?:string; sourceIds:string[]; status:'active'|'paused'|'completed'|'failed'|'abandoned'; steps:CognitivePlanStep[] }
export interface LifeState { spirit?:Spirit; nextCognitionAt?: string; legacyGoalReviewDay?:string; cognitivePlans?: CognitivePlan[]; petId: string; version: number; identity: { name: string; role: string }; legacyContext?: LegacyCognitiveContext; selfModel?: SelfModel; worldModel?: WorldModel; body: Body; emotions: Emotions; goals: Goal[]; commitments: Commitment[]; memories: Memory[]; beliefs: Belief[]; observations: StrategyObservation[]; relationships: Relationship[]; events: LifeEvent[]; actions: LifeAction[]; receipts: ActionReceipt[]; invalidSources: Record<string, string>; constraints: RuntimeConstraints; lastPhysiologyAt: string }
export interface CognitiveWorkspace { goalReadings?: Array<{goalId:string;evidenceId:string;memoryId:string}>; goalReviews?: Goal[]; plans?: CognitivePlan[]; spirit?:Spirit; recentEvents?: Array<Pick<LifeEvent,'eventId'|'type'|'occurredAt'|'evidenceLevel'|'payload'> & {momentSource?:boolean}>; environment?: {userIdleSeconds?:number;space:unknown; inventory:unknown[]; images?:Array<{attachmentId:string;sourceId:string}>; capabilities:Capability[]; recentResults:Array<{actionId:string;status:ActionReceipt['status'];occurredAt:string}>}; petId: string; stateVersion: number; identity: LifeState['identity']; legacyContext?: LegacyCognitiveContext; selfModel?: SelfModel; worldModel?: WorldModel; body: Body; emotions: Emotions; activeGoals: Goal[]; commitments: Commitment[]; relevantMemories: Memory[]; beliefs: Belief[]; relationships: Relationship[]; constraints: RuntimeConstraints }
/** Load projects the authoritative body; commit CASes the shared envelope and persists only kernel-owned fields. Every body mutation must advance the same version. */
export interface KernelStore { load(petId: string): Promise<LifeState | null>; commit(petId: string, expectedVersion: number, next: LifeState): Promise<boolean> }
