// Required modules
var redis = require('redis');
var mysql = require('mysql');
var crypto = require('crypto');

var client, core;

// Database model
var model =
{
    events:
    {
        mysql: ['error'],
        redis: ['ready']
    },
    
    // Database connection variables
    redis: false,
    mysql: false,

    // Function to connect to our databases
    connect: function(config)
    {
        // Main redis connection
        model.redis = redis.createClient(6303);

        // Redis connection for IPC
        model.redisIPC = redis.createClient(6303);

        // MySQL connection
        model.mysql = mysql.createConnection(
        {
            host     : 'localhost',
            user     : core.secrets.mysql.username,
            password : core.secrets.mysql.password,
            database : core.secrets.mysql.database,
            timezone : 'utc' 
        });

        model.mysql.connect();
    },

    disconnect: function()
    {
        model.redis.quit();
        model.redisIPC.quit();
        
        model.mysql.end();
    },

    // Function to generate select statements from objects
    where: function(select, glue)
    {
        if(typeof glue == "undefined")
            glue = " and ";

        var where = [];
        var values = [];
        
        for(var i = 0, keys = Object.keys(select), l = keys.length; i < l; i++)
        {
            where.push(model.mysql.escapeId(keys[i]) + ' = ?');
            values.push(select[keys[i]]);
        }

        return {where: where.join(glue), values: values};
    },

    token:
    {
        generate: function(callback)
        {
            var salt = crypto.randomBytes(32).toString('base64');
            var noise = crypto.randomBytes(32).toString('base64');
            var token = crypto.createHmac("sha256", salt).update(noise).digest("hex");

            // Check to make sure the generated ID doesn't already exist
            model.redis.get("token:" + token, function(error, response)
            {
                // Return false on error
                if(error)
                {
                    callback(false);
                }
                // If this ID is already in use, try generating again (hahah there was a collision, YEAH RIGHT)
                else if(response)
                {
                    generate_id(callback);
                }
                // Otherwise, pass our generated ID to the callback
                else if(typeof callback == "function")
                {
                    callback(token);
                }
            });
        },
        
        set: function(user, command, callback)
        {
            var data = {user: user, command: command};

            model.token.generate(function(token)
            {
                // Return false on error
                if(!token)
                {
                    callback(false);
                }
                
                // Save this token for 15 minutes
                model.redis.set("token:" + token, JSON.stringify(data), 'ex', 900, function(error, response)
                {
                    if(error)
                    {
                        callback(false);
                    }
                    else
                    {
                        callback(token);
                    }
                });
            });
        },

        get: function(token, callback)
        {
            model.redis.get("token:" + token, callback);
        },

        delete: function(token, callback)
        {
            model.redis.del("token:" + token, callback);
        }
    },

    user:
    {
        register: function(auth, callback)
        {            
            // Try to insert new user account, don't worry if there's a duplicate
            model.mysql.query("Insert into `accounts` set ?", {fish_id: auth.session.user_id}, function(error, response)
            {
                if(error)
                {
                    // Log out the error, just in case...
                    console.log(error, response);
                }

                model.user.get({fish_id: auth.session.user_id}, function(error, user)
                {
                    if(error)
                    {
                        console.log(error, response);
                    }
                    else
                    {
                        var data =
                        {
                            account_id: user.account_id,
                            name: auth.name
                        };
                        
                        // Insert new user name
                        model.mysql.query("Insert into `names` set ?, `registered` = now(), `active` = now()", data);

                        // Add one to the user names count
                        model.mysql.query("Update `accounts` set `names` = `names` + 1 where `account_id` = ?", user.account_id, function(error, response)
                        {
                            // Return callback with user data
                            model.user.get({account_id: user.account_id}, callback);
                        });
                    }
                });
            });
        },

        login: function(user, callback)
        {
            // Update user activity time
            model.mysql.query("Update `names` set `active` = now() where `name` = ?", user, callback);
        },

        // Get all user data
        get: function(select, callback)
        {
            // First get account data
            select = model.where(select);
            model.mysql.query("Select * from `accounts` where "+select.where+" limit 1", select.values, function(error, response)
            {
                if(error || !response.length)
                {
                    callback(error, {names: []});
                }
                else
                {
                    var account = response[0];

                    // Now get all user names
                    model.user.name({account_id: account.account_id}, function(error, response)
                    {
                        account.names = (response || []);
                        callback(error, account);
                    });
                }
            });
        },

        // Get name data
        name: function(select, callback)
        {
            select = model.where(select);
            model.mysql.query("Select * from `names` where "+select.where, select.values, callback);
        },

        // Set a user's hostname
        host: function(user, host, callback)
        {
            // Get account info
            model.user.name({name: user}, function(error, response)
            {
                if(error || !response.length)
                {
                    callback(error, response);
                }
                else
                {
                    var name = response[0];
                    model.mysql.query("Update `accounts` set `host` = ? where `account_id` = ?", [host, name.account_id], callback);
                }
            });
        }
    },

    channel:
    {

    },

    // Database triggered events
    ////////////////////////////////////////
    
    mysql_error: function(error)
    {
        console.log('Database Error!', error);

        if(error.code === 'PROTOCOL_CONNECTION_LOST')
        {
            console.log("Reconnecting...");
            model.disconnect();

            // Try reconnecting in a few seconds...
            setTimeout(function()
            {
                model.connect();
            }, 3000);
        }
    },

    redis_ready: function()
    {
        console.log("Connected to redis.");
    },

    // Helper functions to bind and unbind model events
    bind: function()
    {
        for(var i = 0, l = model.events.mysql.length; i < l; i++)
        {
            var event = model.events.mysql[i];
            model.mysql.addListener(event, model["mysql_" + event]);
        }

        for(var i = 0, l = model.events.redis.length; i < l; i++)
        {
            var event = model.events.redis[i];
            model.redis.addListener(event, model["redis_" + event]);
        }
    },

    unbind: function()
    {
        for(var i = 0, l = model.events.mysql.length; i < l; i++)
        {
            var event = model.events.mysql[i];
            model.mysql.removeListener(event, model["mysql_" + event]);
        }

        for(var i = 0, l = model.events.redis.length; i < l; i++)
        {
            var event = model.events.redis[i];
            model.redis.removeListener(event, model["redis_" + event]);
        }
    }
};

module.exports =
{
    // Function to get the model when loaded by the webserver
    get: function(_core)
    {
        core = _core;
        return model;
    },

    // Called when this file is loaded as a bot module
    load: function(_client, _core)
    {
        client = _client;
        core = _core;

        model.connect();
        model.bind();
        
        core.model = model;
    },

    unload: function(_client, _core)
    {
        model.disconnect();
        model.unbind();
        
        delete core.model;
        delete client, core, crypto, model;
    }
}
