var request = require('request'),
    path = require("path"),
    fs = require("fs"),
    async = require("async"),
    spawn = require('child_process').spawn,
    moment = require('moment'),
    Bunzip = require('seek-bzip'),
    utility = require('./utility'),
    matches = utility.matches,
    players = utility.players,
    AWS = require('aws-sdk'),
    BigNumber = require('big-number').n,
    $ = require('cheerio'),
    steam = require("steam"),
    dota2 = require("dota2"),
    Steam = new steam.SteamClient(),
    Dota2 = new dota2.Dota2Client(Steam, false);
var aq = async.queue(apiRequest, 1)
var pq = async.queue(parseReplay, 1)
var api_delay = 1000
var replay_dir = process.env.REPLAY_DIR || "replays/"
var parser_file = process.env.PARSER_FILE || "./parser/target/stats-0.1.0.jar"
var api_url = "https://api.steampowered.com/IDOTA2Match_570"
var summaries_url = "http://api.steampowered.com/ISteamUser"
if(!fs.existsSync(replay_dir)) {
    fs.mkdir(replay_dir)
}
aq.empty = function() {
    queueRequests()
    requestDetails()
}
setInterval(updateNames, 86400 * 1000)
setInterval(function() {
    console.log('[QUEUES] %s api, %s parse', aq.length(), pq.length())
}, 10000)
updateConstants()
queueRequests()
parseMatches()
/*
 * Reloads the api queue with tracked users
 */

function queueRequests() {
    //todo poll the full match feed for fewer api reqs?
    //when a user is added we should get their matches once
}
/*
 * Reloads the parse queue with matches needing parse
 */

function parseMatches() {
    matches.find({
        parse_status: 0
    }, function(err, docs) {
        pq.push(docs, function(err) {})
    })
}
/*
 * Updates constant values from web sources
 */

function updateConstants() {
    var constants = require('./constants.json')
    async.map(["https://api.steampowered.com/IEconDOTA2_570/GetHeroes/v0001/?key=" + process.env.STEAM_API_KEY + "&language=en-us", "http://www.dota2.com/jsfeed/itemdata", "https://raw.githubusercontent.com/kronusme/dota2-api/master/data/mods.json", "https://raw.githubusercontent.com/kronusme/dota2-api/master/data/regions.json"], getData, function(err, results) {
        var heroes = results[0].result.heroes
        var items = results[1].itemdata
        heroes.forEach(function(hero) {
            hero.img = "http://cdn.dota2.com/apps/dota2/images/heroes/" + hero.name.replace('npc_dota_hero_', "") + "_sb.png"
        })
        constants.item_ids = {}
        for(var key in items) {
            constants.item_ids[items[key].id] = key
            items[key].img = "http://cdn.dota2.com/apps/dota2/images/items/" + items[key].img
        }
        constants.heroes = buildLookup(heroes)
        constants.items = items
        constants.modes = buildLookup(results[2].mods)
        constants.regions = buildLookup(results[3].regions)
        console.log("[UPDATE] writing constants file")
        fs.writeFileSync("./constants.json", JSON.stringify(constants, null, 4))
    })
}

function buildLookup(array) {
    var lookup = {}
    for(var i = 0; i < array.length; i++) {
        lookup[array[i].id] = array[i]
        lookup[array[i].name] = array[i]
    }
    return lookup
}
/*
 * Updates display names for all players
 */

function updateNames() {
    //todo albert implement this
}
/*
 * Queues a request for display names for an array of players
 */

function queueSummaryRequest(players) {
    summaries = {}
    summaries.summaries_id = 1
    summaries.players = players
    aq.unshift(summaries, function(err) {})
}
/*
 * Generates a URL to access an api
 */

function generateURL(req) {
    if(req.account_id) {
        return api_url + "/GetMatchHistory/V001/?key=" + process.env.STEAM_API_KEY + "&account_id=" + req.account_id
    }
    if(req.match_id) {
        return api_url + "/GetMatchDetails/V001/?key=" + process.env.STEAM_API_KEY + "&match_id=" + req.match_id;
    }
    if(req.summaries_id) {
        var steamids = []
        req.players.forEach(function(player) {
            steamids.push(BigNumber('76561197960265728').plus(player.account_id).toString())
        })
        var query = steamids.join()
        return summaries_url + "/GetPlayerSummaries/v0002/?key=" + process.env.STEAM_API_KEY + "&steamids=" + query
    }
}

function getData(url, cb) {
    console.log("[API] %s", url)
    request(url, function(err, res, body) {
        if(err || res.statusCode != 200) {
            cb(err || "response code != 200")
        } else {
            cb(null, JSON.parse(body))
        }
    })
}
/*
 * Processes a request to an api
 */

function apiRequest(req, cb) {
    getData(generateURL(req), function(err, data) {
        if(err) {
            return cb(err)
        }
        if(req.account_id) {
            //todo foreach if newer than last_match
            //if a tracked player is in match, queue
            //update last_match
            aq.push(match, function(err) {})
            setTimeout(cb, api_delay, null)
        }
        if(req.match_id) {
            var match = data.result
            match.parse_status = 0
            matches.insert(match, function(err) {
                queueSummaryRequest(match.players)
                pq.push(match, function(err) {})
                setTimeout(cb, api_delay, null)
            })
        }
        if(req.summaries_id) {
            async.map(data.response.players, insertPlayer, function(err) {
                setTimeout(cb, api_delay, null)
            })
        }
    })
}
/*
 * Inserts/updates a player in the database
 */

function insertPlayer(player, cb) {
    var account_id = Number(BigNumber(player.steamid).minus('76561197960265728'))
    players.update({
        account_id: account_id
    }, {
        $set: {
            display_name: player.personaname
        }
    }, {
        upsert: true
    }, function(err) {
        cb(err)
    })
}
/*
 * Downloads a match replay
 */

function download(match, cb) {
    var match_id = match.match_id
    var fileName = replay_dir + match_id + ".dem"
    if(fs.existsSync(fileName)) {
        console.log("[PARSER] found local replay for match %s", match_id)
        cb(null, fileName);
    } else {
        if(match.start_time > moment().subtract(7, 'days').format('X')) {
            getReplayUrl(match, function(err, url) {
                if(err) {
                    cb(err)
                }
                downloadWithRetry(url, fileName, 1000, function() {
                    console.log("[PARSER] downloaded valve replay for match %s", match_id)
                    uploadToS3(fileName, function(err) {
                        cb(null, fileName)
                    })
                })
            })
        } else {
            if(process.env.AWS_S3_BUCKET) {
                var s3 = new AWS.S3()
                var params = {
                    Bucket: process.env.AWS_S3_BUCKET,
                    Key: fileName
                }
                s3.getObject(params, function(err, data) {
                    if(err) {
                        console.log('[S3] Replay not found in S3')
                        cb("Replay expired")
                    } else {
                        console.log("[PARSER] Downloaded S3 replay for match %s", match_id)
                        fs.writeFileSync(fileName, data.Body);
                        cb(null, fileName)
                    }
                })
            } else {
                console.log('[S3] S3 is not defined')
                cb("Replay expired")
            }
        }
    }
}
/*
 * Uploads a replay to S3
 */

function uploadToS3(fileName, cb) {
    if(!process.env.AWS_S3_BUCKET) {
        console.log('[S3] S3 is not defined')
        return cb(null)
    }
    var s3 = new AWS.S3()
    var params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: fileName
    }
    s3.headObject(params, function(err, data) {
        if(err) {
            params.Body = fs.readFileSync(fileName)
            s3.putObject(params, function(err, data) {
                if(err) {
                    console.log('[S3] could not upload to S3')
                    cb(true);
                } else {
                    console.log('[S3] Successfully uploaded replay to S3: %s ', fileName)
                    cb(null)
                }
            })
        } else {
            console.log('[S3] replay already exists in S3')
            cb(null)
        }
    })
}
/*
 * Logs onto steam and launches Dota 2
 */

function logOnSteam(user, pass, authcode, cb) {
    var onSteamLogOn = function onSteamLogOn() {
        console.log("[STEAM] Logged on.");
        Dota2.launch();
        Dota2.on("ready", function() {
            cb(null)
        })
    },
        onSteamSentry = function onSteamSentry(newSentry) {
            console.log("[STEAM] Received sentry.");
            fs.writeFileSync("sentry", newSentry);
        },
        onSteamServers = function onSteamServers(servers) {
            console.log("[STEAM] Received servers.");
            fs.writeFile("servers", JSON.stringify(servers));
        },
        onSteamError = function onSteamError(e) {
            if(e.cause == "logonFail") {
                switch(e.eresult) {
                    case steam.EResult.InvalidPassword:
                        throw "Error: Steam cannot log on - Invalid password.";
                    case steam.EResult.AccountLogonDenied:
                        throw "Error: Steam cannot log on - Account logon denied (Steam Guard code required)";
                    case steam.EResult.InvalidLoginAuthCode:
                        throw "Error: Steam cannot log on - Invalid Steam Guard code (remove whats set in config.js to have a new one sent)";
                    case steam.EResult.AlreadyLoggedInElsewhere:
                        throw "Error: Steam cannot log on - Account already logged in elsewhere.";
                }
            }
        };
    if(!fs.existsSync("sentry")) {
        fs.openSync("sentry", 'w')
    }
    var logOnDetails = {
        "accountName": user,
        "password": pass
    },
        sentry = fs.readFileSync("sentry");
    if(authcode) logOnDetails.authCode = authcode;
    if(sentry.length) logOnDetails.shaSentryfile = sentry;
    Steam.logOn(logOnDetails);
    Steam.on("loggedOn", onSteamLogOn).on('sentry', onSteamSentry).on('servers', onSteamServers).on('error', onSteamError);
}
/*
 * Gets the replay url from dota
 */

function getReplayUrl(match, cb) {
    if(match.replay_url) {
        console.log("[PARSER] found replay_url in db")
        return cb(null, match.replay_url)
    }
    if(!Steam.loggedOn) {
        //todo select a random set of creds every time
        logOnSteam(process.env.STEAM_USER, process.env.STEAM_PASS, process.env.STEAM_GUARD_CODE, function(err) {
            getReplayUrl(match, cb)
        })
    } else {
        console.log("[DOTA] requesting replay %s", match.match_id)
        var timeoutProtect = setTimeout(function() {
            // Clear the local timer variable, indicating the timeout has been triggered.
            timeoutProtect = null;
            Dota2.exit()
            Steam.logOff()
            console.log("[DOTA] request for replay timed out, relogging")
            getReplayUrl(match, cb)
        }, 15000)
        Dota2.matchDetailsRequest(match.match_id, function(err, data) {
            if(timeoutProtect) {
                clearTimeout(timeoutProtect);
                if(err) {
                    return cb(err)
                }
                var url = "http://replay" + data.match.cluster + ".valve.net/570/" + match.match_id + "_" + data.match.replaySalt + ".dem.bz2";
                matches.update({
                    match_id: match.match_id
                }, {
                    $set: {
                        replay_url: url
                    }
                })
                return cb(null, url)
            }
        })
    }
}
/*
 * Tries to download a file from the url repeatedly
 */

function downloadWithRetry(url, fileName, timeout, cb) {
    request({
        url: url,
        encoding: null
    }, function(err, response, body) {
        if(err || response.statusCode !== 200) {
            console.log("[PARSER] failed to download from %s, retrying in %ds", url, timeout / 1000)
            setTimeout(downloadWithRetry, timeout, url, fileName, timeout * 2, cb);
        } else {
            body = Bunzip.decode(body);
            fs.writeFile(fileName, body, function(err) {
                cb(null)
            });
        }
    })
}
/*
 * Parses a replay for a match
 */

function parseReplay(match, cb) {
    var match_id = match.match_id
    console.log("[PARSER] requesting parse for match %s", match_id)
    download(match, function(err, fileName) {
        if(err) {
            console.log("[PARSER] Error for match %s: %s", match_id, err)
            matches.update({
                match_id: match_id
            }, {
                $set: {
                    parse_status: 1
                }
            })
            return cb(err)
        }
        console.log("[PARSER] running parse on %s", fileName)
        var output = ""
        var cp = spawn("java", ["-jar",
                                parser_file,
                                fileName, "constants.json"
                               ])
        cp.stdout.on('data', function(data) {
            output += data
        })
        cp.stderr.on('data', function(data) {
            console.log('[PARSER] match: %s, stderr: %s', match_id, data);
        })
        cp.on('close', function(code) {
            console.log('[PARSER] match: %s, exit code: %s', match_id, code);
            if(!code) {
                matches.update({
                    match_id: match_id
                }, {
                    $set: {
                        parsed_data: JSON.parse(output)
                    }
                })
                matches.update({
                    match_id: match_id
                }, {
                    $set: {
                        parse_status: 2
                    }
                })
                if(process.env.DELETE_REPLAYS) {
                    fs.unlink(fileName)
                }
            }
            cb(code)
        })
    })
}