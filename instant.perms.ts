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
    bind: ['isOwner', "auth.id in data.ref('owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('owner' in request.modifiedFields)",
    },
  },
  entryHistory: {
    bind: ['isOwner', "auth.id in data.ref('entry.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      update: 'false',
      delete: 'isOwner',
    },
  },
} satisfies InstantRules<AppSchema>;

export default rules;
