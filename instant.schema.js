import { i } from '@instantdb/react';

const _schema = i.schema({
  entities: {
    profiles: i.entity({
      username:        i.string(),
      user_master_key: i.string(),
    }),
    entries: i.entity({
      entry_key: i.string(),
      value:     i.string(),
    }),
  },
  links: {
    profileUser: {
      forward: { on: 'profiles', has: 'one',  label: '$user'   },
      reverse: { on: '$users',   has: 'one',  label: 'profile' },
    },
    entryUser: {
      forward: { on: 'entries', has: 'one',  label: '$user'   },
      reverse: { on: '$users',  has: 'many', label: 'entries' },
    },
  },
});

export default _schema;
