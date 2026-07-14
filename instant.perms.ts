import type { InstantRules } from '@instantdb/react';
import type { AppSchema } from './instant.schema';

const rules = {
  keyStore: {
    bind: ['isOwner', "auth.id in data.ref('owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('owner' in request.modifiedFields)",
    },
  },
  entries: {
    bind: ['isOwner', "auth.id in data.ref('keyBlob.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('keyBlob' in request.modifiedFields)",
    },
  },
  $files: {
    bind: ['isOwnPath', "data.path.startsWith(auth.id + '/')"],
    allow: {
      view: 'isOwnPath',
      create: 'isOwnPath',
      delete: 'isOwnPath',
      update: 'isOwnPath',
    },
  },
} satisfies InstantRules<AppSchema>;

export default rules;
