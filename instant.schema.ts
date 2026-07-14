import { i } from '@instantdb/react';

// Pulled from the live app (npx instant-cli@latest pull schema) rather than
// hand-maintained: this file drifting from what's actually live caused
// several real bugs earlier (see docs/data_model.md, Uniqueness), so the
// live schema is treated as the source of truth going forward. $files holds
// entry data and entry history now (see entryFileEntry/historyFileEntry
// below), no longer just a schema internal; $usersLinkedPrimaryUser is still
// an InstantDB system link this app never touches directly, kept because the
// query validator needs local schema for anything a dot-notation where
// filter traverses into, same reason $users itself must be declared
// explicitly.
//
// keyStoreOwner's reverse side is has: 'many', not 'one': a genuine
// has:'one'/has:'one' one-to-one on this link produced a persistent
// "already exists" uniqueness rejection even after confirming zero
// existing keyStore rows, no leftover entities from diagnostic renames,
// and correct auth. Backend enforcement was backed off; "one keyStore row
// per user" is enforced client side instead, by ensureKeyStore in
// src/db.js treating more than one matching row as a fatal error rather
// than silently picking one. entryFileEntry/historyFileEntry below use the
// same has: 'many' cardinality up front, for the same reason, rather than
// risk hitting this a second time (see docs/data_model.md, Links).

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string().optional(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    entries: i.entity({
      entryKey: i.string(),
    }),
    keyStore: i.entity({
      umkBlob: i.string(),
    }),
  },
  links: {
    $usersLinkedPrimaryUser: {
      forward: {
        on: '$users',
        has: 'one',
        label: 'linkedPrimaryUser',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'many',
        label: 'linkedGuestUsers',
      },
    },
    entriesOwner: {
      forward: {
        on: 'entries',
        has: 'one',
        label: 'owner',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'many',
        label: 'entries',
      },
    },
    // No required: true on either of these two, unlike entriesOwner above:
    // the $files row is created by a separate db.storage.uploadFile call
    // before the db.transact that links it (see docs/crypto.md, Entry Data
    // File / History File / Save Ordering), so for a moment after upload the
    // file exists unlinked; required would reject that transient state.
    entryFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'entry',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'entries',
        has: 'many',
        label: 'entryFile',
      },
    },
    historyFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'historyEntry',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'entries',
        has: 'many',
        label: 'historyFile',
      },
    },
    // required: true is deliberately absent here, unlike the other two
    // owner links: the dashboard recreation of this link (see the comment
    // above) did not set it, and this file mirrors what is actually live,
    // not what would ideally be set. ensureKeyStore always provides owner
    // when creating a keyStore row regardless, so this has no functional
    // effect today; set "Require this attribute" in the dashboard and add
    // it back here if closing that gap ever matters.
    keyStoreOwner: {
      forward: {
        on: 'keyStore',
        has: 'one',
        label: 'owner',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'many',
        label: 'keyStore',
      },
    },
  },
  rooms: {},
});

// This idiom (re-exporting the inferred type via an empty interface) is
// InstantDB's own convention for schema files, see the CLI-generated
// boilerplate at https://instantdb.com/docs/modeling-data.
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
