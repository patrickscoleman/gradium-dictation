import { sharedCache } from '../lib/cache.js';
import { handleTranscribe } from '../lib/handlers.js';

const handle = (request) => handleTranscribe(request, { cache: sharedCache() });
export { handle as GET, handle as POST };
