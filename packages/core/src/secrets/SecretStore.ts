export interface SecretStore {
  getSecret(participantId: string, key: string): Promise<string | null>;
  setSecret(participantId: string, key: string, secret: string): Promise<void>;
  removeSecret(participantId: string, key: string): Promise<void>;
  /** Key names only — values are never listable. */
  listKeys(participantId: string): Promise<string[]>;
}
