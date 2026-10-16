/**
 * Dependencies handed to external connector factories. Deliberately narrow and
 * structural: the external package imports these TYPES only. No event bus —
 * connectors must not subscribe to the bus (design decision, spec §4.4).
 */
export interface CollectiveLike {
  list(): Array<{
    id: string;
    identities?: Array<{ connector: string; externalId: string }>;
    status?: string;
  }>;
  get(
    participantId: string,
  ):
    | { id: string; identities?: Array<{ connector: string; externalId: string }>; status?: string }
    | undefined;
  findByIdentity(
    connector: string,
    externalId: string,
  ): { id: string; identities?: Array<{ connector: string; externalId: string }> } | undefined;
  getOrThrow(participantId: string): unknown;
}

export interface SecretStoreLike {
  getSecret(participantId: string, key: string): Promise<string | null>;
}

export interface ConnectorRuntimeDeps {
  collective: CollectiveLike;
  secrets?: SecretStoreLike;
}
