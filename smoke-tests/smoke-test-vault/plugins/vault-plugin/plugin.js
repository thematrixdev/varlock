plugin.name = 'vault';
plugin.icon = 'skill-icons:vault-dark';

const pluginInstances = {};

plugin.registerRootDecorator({
  name: 'initVault',
  description: 'Initialize a mock Vault plugin instance',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new plugin.ERRORS.SchemaError(`Instance "${id}" already initialized`);
    }
    pluginInstances[id] = { id };
    return { id };
  },
  async execute({ id: _id }) {
    // no-op for mock
  },
});

plugin.registerResolverFunction({
  name: 'vault',
  label: 'Mock Vault secret resolver',
  icon: 'skill-icons:vault-dark',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 3 },
  process() {
    let instanceId = '_default';
    let pathResolver;
    let keyResolver;
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      pathResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      pathResolver = this.arrArgs[0];
      keyResolver = this.arrArgs[1];
    } else if (argCount === 3) {
      instanceId = String(this.arrArgs[0].staticValue);
      pathResolver = this.arrArgs[1];
      keyResolver = this.arrArgs[2];
    }

    if (!pluginInstances[instanceId]) {
      throw new plugin.ERRORS.SchemaError(`Vault instance "${instanceId}" not found`);
    }

    return { instanceId, pathResolver, keyResolver };
  },
  async resolve({ instanceId: _instanceId, pathResolver, keyResolver }) {
    const path = await pathResolver.resolve();
    if (keyResolver) {
      const key = await keyResolver.resolve();
      return `mock-vault-${path}-${key}`;
    }
    return JSON.stringify({ mock: `vault-${path}` });
  },
});
