export interface StoredCredential {
  /** Hashing scheme identifier, e.g. 'argon2id'. */
  scheme: string;
  /** The hash string (self-describing for argon2). */
  hash: string;
  updatedAt: string;
}

export interface CredentialStore {
  getCredential(participantId: string): Promise<StoredCredential | null>;
  setCredential(participantId: string, secret: string): Promise<void>;
  removeCredential(participantId: string): Promise<void>;
  verify(participantId: string, secret: string): Promise<boolean>;
}
