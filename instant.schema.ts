import { i } from '@instantdb/react';

// Entities, links, and permission rules are specified in docs/data_model.md.
// Every field beyond row id and the owner/entry link is an opaque encrypted
// blob; InstantDB never sees plaintext content.

const _schema = i.schema({
  entities: {
    // Declared explicitly, matching the real fields InstantDB's own pull of
    // this app's live schema showed, even though $users is a system entity
    // this app never writes to directly. Without this, dot-notation where
    // filters that traverse a link into $users (e.g. 'owner.id') fail
    // validation: the query validator has no local schema for $users to
    // resolve the path against, even though the link to it works fine on
    // its own.
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    keyStore: i.entity({
      umkBlob: i.string(),
      backupKeyBlob: i.string(),
    }),
    entries: i.entity({
      entryKey: i.string(),
      encryptedData: i.string(),
    }),
    entryHistory: i.entity({
      encryptedSnapshot: i.string(),
    }),
  },
  // Links were created via the InstantDB dashboard UI instead of pushed via
  // the CLI: pushing new links to $users hit an unresolved CLI/backend bug
  // (see docs/data_model.md). This must mirror the live schema exactly,
  // including the reverse label names actually created in the dashboard
  // (init() passes this object to InstantDB, which validates queries against
  // it, not against whatever is live on the backend), or queries silently
  // see "no links" regardless of what the dashboard shows.
  links: {
    keyStoreOwner: {
      forward: { on: 'keyStore', has: 'one', label: 'owner', required: true, onDelete: 'cascade' },
      reverse: { on: '$users', has: 'one', label: 'keyStore' },
    },
    entriesOwner: {
      forward: { on: 'entries', has: 'one', label: 'owner', required: true, onDelete: 'cascade' },
      reverse: { on: '$users', has: 'many', label: 'entries' },
    },
    entryHistoryEntry: {
      forward: { on: 'entryHistory', has: 'one', label: 'entry', required: true, onDelete: 'cascade' },
      reverse: { on: 'entries', has: 'many', label: 'entryHistory' },
    },
  },
});

// This idiom (re-exporting the inferred type via an empty interface) is
// InstantDB's own convention for schema files, see the CLI-generated
// boilerplate at https://instantdb.com/docs/modeling-data.
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
