import { init } from '@instantdb/react';
import schema from '../instant.schema.js';

export function createDb(appId) {
  return init({ appId, schema });
}
