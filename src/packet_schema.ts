export type PacketOutputFormat = "agent" | "prompt";

export type PinnedRef = {
  root: "repo" | "change";
  path: string;
  blob_sha: string;
};

export type FindingSelector = {
  evidence_id: string;
  finding_uid: string;
  evidence_ref: PinnedRef;
};

export type DecisionSelector = {
  evidence_id: string;
  decision_scope_key: string;
  evidence_ref: PinnedRef;
};

export type WorkflowPacket = {
  stage: string;
  current_gate: string;
  task_id?: string;
  status: "allowed" | "blocked";
  top_blockers?: string[];
  blocker_count?: number;
  has_more_blockers?: boolean;
  next_action: string;
  next_command?: string;
  openspec_cli_surfaces?: string[];
  must_read_refs: PinnedRef[];
  must_read_verbatim_findings?: FindingSelector[];
  must_read_verbatim_decisions?: DecisionSelector[];
  diagnostic_command?: string;
  // B (template serving): explore_complete only. The model fills discovery.md from this skeleton +
  // rules so output structure is uniform across models instead of freehanded and gate-heuristic-parsed.
  discovery_template?: string;
  discovery_rules?: string[];
};

export type ReviewPacket = {
  consumer: "role" | "main-thread";
  gate: string;
  role: string;
  round: number;
  target_refs: PinnedRef[];
  source_refs: PinnedRef[];
  required_load_refs?: PinnedRef[];
  required_claim_ids?: string[];
  must_read_verbatim_findings?: FindingSelector[];
  must_read_verbatim_decisions?: DecisionSelector[];
  required_output_kind: string;
  output_contract_fields: string[];
  required_review_scope?: string[];
  stop_conditions: string[];
};

export type ApplyWorkerPacket = Record<string, any>;

export type PacketDispatchResult =
  | { output_format: "agent"; payload: WorkflowPacket | ReviewPacket | ApplyWorkerPacket }
  | { output_format: "prompt"; payload: string };
