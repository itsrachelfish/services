var irc = require("irc");

// Get server configuration
var config = require("./config/chanserv.js");
var secrets = require("./config/secret.js");

// Connect to IRC
var client = new irc.Client(config.server, config.name, config);

// Get modules that should be loaded immediately
var modules = ['oper', 'chanserv']

// Require core functions
var core = require("./core.js");

// Initialize modules with the existing client
core.init(client, modules, secrets);

