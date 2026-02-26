const rules = {
  profiles: {
    allow: {
      view:   "auth.id in data.ref('$user.id')",
      create: "auth.id in data.ref('$user.id')",
      update: "auth.id in data.ref('$user.id')",
      delete: "auth.id in data.ref('$user.id')",
    },
  },
  entries: {
    allow: {
      view:   "auth.id in data.ref('$user.id')",
      create: "auth.id in data.ref('$user.id')",
      update: "auth.id in data.ref('$user.id')",
      delete: "auth.id in data.ref('$user.id')",
    },
  },
};

export default rules;
