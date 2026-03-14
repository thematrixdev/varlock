plugin.name = 'psono';
plugin.icon = 'mdi:shield-key';

const pluginInstances = {};

plugin.registerRootDecorator({
  name: 'initPsono',
  description: 'Initialize a mock Psono plugin instance',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new plugin.ERRORS.SchemaError(`Instance "${id}" already initialized`);
    }
    const configPath = objArgs?.configPath
      ? String(objArgs.configPath.staticValue)
      : undefined;
    pluginInstances[id] = { id, configPath };
    return { id, configPath };
  },
  async execute({ id: _id, configPath: _configPath }) {
    // no-op for mock
  },
});

plugin.registerResolverFunction({
  name: 'psono',
  label: 'Mock Psono secret resolver',
  icon: 'mdi:shield-key',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 3 },
  process() {
    let instanceId = '_default';
    let secretIdResolver;
    let fieldResolver;
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      secretIdResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      secretIdResolver = this.arrArgs[0];
      fieldResolver = this.arrArgs[1];
    } else if (argCount === 3) {
      instanceId = String(this.arrArgs[0].staticValue);
      secretIdResolver = this.arrArgs[1];
      fieldResolver = this.arrArgs[2];
    }

    if (!pluginInstances[instanceId]) {
      throw new plugin.ERRORS.SchemaError(`Psono instance "${instanceId}" not found`);
    }

    return { instanceId, secretIdResolver, fieldResolver };
  },
  async resolve({ instanceId, secretIdResolver, fieldResolver }) {
    const secretId = await secretIdResolver.resolve();
    let field = 'password';
    if (fieldResolver) {
      field = await fieldResolver.resolve();
    }
    return `mock-${instanceId}-${secretId}-${field}`;
  },
});

plugin.registerResolverFunction({
  name: 'psonoTotp',
  label: 'Mock Psono TOTP resolver',
  icon: 'mdi:shield-key',
  argsSchema: { type: 'array', arrayMinLength: 1, arrayMaxLength: 2 },
  process() {
    let instanceId = '_default';
    let secretIdResolver;
    const argCount = this.arrArgs?.length ?? 0;

    if (argCount === 1) {
      secretIdResolver = this.arrArgs[0];
    } else if (argCount === 2) {
      instanceId = String(this.arrArgs[0].staticValue);
      secretIdResolver = this.arrArgs[1];
    }

    if (!pluginInstances[instanceId]) {
      throw new plugin.ERRORS.SchemaError(`Psono instance "${instanceId}" not found`);
    }

    return { instanceId, secretIdResolver };
  },
  async resolve({ instanceId: _instanceId, secretIdResolver }) {
    const secretId = await secretIdResolver.resolve();
    return `mock-totp-${secretId}`;
  },
});
