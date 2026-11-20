import { sharedCache } from '../lib/cache.js';
import { handleStatus } from '../lib/handlers.js';

const handle = (request) => handleStatus(request, { cache: sharedCache() });
export { handle as GET, handle as POST };
