import type { LeancryptoModule } from '../src/crypto';

declare const leancrypto: () => Promise<LeancryptoModule>;
export default leancrypto;
