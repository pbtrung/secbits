import type { InstantRules } from '@instantdb/react';
import type { AppSchema } from './instant.schema';

// Verbatim from docs/data_model.md, Permission rules. InstantDB treats any
// action left unspecified as allow, not deny, so every action on every
// entity below is listed explicitly, never left to the default.
//
// IMPORTANT, unresolved until tested against a live app: the `newData.owner
// == data.owner` clauses below are meant to pin the `owner` link so it can't
// be reassigned after creation (InstantDB evaluates `data` as the pre update
// state and exposes the incoming write as `newData`). InstantDB's own
// documented example for this pattern, `newData.creatorId == data.creatorId`,
// compares a plain scalar attribute, not a link. `owner` is a link, so these
// two lines use `.ref('owner.id')` on both sides to stay consistent with how
// every other rule here reads a link, but this exact comparison has not been
// verified to work for links and must be checked against a real InstantDB
// app before relying on it (see docs/testing.md, Permission rules, for the
// two-user test matrix to run).

const rules = {
  keyStore: {
    bind: ['isOwner', "auth.id in data.ref('owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && newData.ref('owner.id') == data.ref('owner.id')",
    },
  },
  entries: {
    bind: ['isOwner', "auth.id in data.ref('owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && newData.ref('owner.id') == data.ref('owner.id')",
    },
  },
  entryHistory: {
    bind: ['isOwner', "auth.id in data.ref('entry.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      // Immutable: history snapshots are created or deleted, never modified.
      update: 'false',
      delete: 'isOwner',
    },
  },
} satisfies InstantRules<AppSchema>;

export default rules;
