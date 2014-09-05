var request = require('request'),
    path = require("path"),
    fs = require("fs"),
    http = require('http'),
    Steam = require("./MatchProvider-steam").MatchProvider,
    spawn = require('child_process').spawn,
    winston = require('winston'),
    steam = new Steam(
        process.env.STEAM_USER,
        process.env.STEAM_PASS,
        process.env.STEAM_NAME,
        process.env.STEAM_GUARD_CODE,
        process.env.STEAM_RESPONSE_TIMEOUT),
    logger = new (winston.Logger),
    db = require('./db.js'),
    matches = db.get('matchStats'),
    heroes = db.get('heroes'),
    items = db.get('items'),
    baseURL = "https://api.steampowered.com/IDOTA2Match_570/"

heroes.index('id', {unique: true})
items.index('id', {unique: true})
matches.index('match_id', {unique: true})

logger.add(
    winston.transports.Console,
    {
        timestamp: true
    }
)

/**
 * Generates Get Heroes URL
 */
function generateGetHeroesURL(){
    return "https://api.steampowered.com/IEconDOTA2_570/GetHeroes/v0001/?key="
    + process.env.STEAM_API_KEY + "&language=en_us";
}

/**
 * Generates Match History URL
 */
function generateGetMatchHistoryURL(account_ID, num) {
    return baseURL + "GetMatchHistory/V001/?key=" + process.env.STEAM_API_KEY
    + (account_ID != "undefined" ? "&account_id=" + account_ID : "")
    + (num != "undefined" ? "&matches_requested=" + num : "");
}

/**
 * Generates Match Details URL
 */
function generateGetMatchDetailsURL(match_id) {
    return baseURL + "GetMatchDetails/V001/?key=" + process.env.STEAM_API_KEY
    + "&match_id=" + match_id;
}

/**
 * Makes request for match history
 */
function requestGetMatchHistory(id, num) {
    logger.log("info", "requestGetMatchHistory called")
    request(generateGetMatchHistoryURL(id, num), function(err, res, body){
        if (!err && res.statusCode == 200) {
            var j = JSON.parse(body);
            j.result.matches.forEach(function(match, i) {
                matches.findOne({match_id: match.match_id}, function(err, data) {
                    if (err) throw err
                    if (!data) {
                        setTimeout(requestGetMatchDetails, i * 1000, match.match_id)
                    }
                })
            })
        }
    })
}

/**
 * Makes request for match details
 */
function requestGetMatchDetails(id) {
    logger.log("info", "requestGetMatchDetails called")
    request(generateGetMatchDetailsURL(id), function(err, res, body){
        if (!err && res.statusCode == 200) {
            var result = JSON.parse(body).result
            matches.insert(result);
        }
    })
}

/**
 * Makes request for heroes list
 */
function requestGetHeroes() {
    logger.log("info", "getHeroes called")
    request(generateGetHeroesURL(), function(err, res, body){
        if (!err && res.statusCode == 200) {
            var result = JSON.parse(body).result
            if (result.count > 100) {
                result.heroes.forEach(function(elem){
                    heroes.insert(elem);
                })
            }    
        }
    })
}

/**
 * Makes request for items list
 */
function requestGetItems() {
    logger.log("info", "getItems called")
    request("http://www.dota2.com/jsfeed/itemdata", function(err, res, body){
        if (!err && res.statusCode == 200) {
            var result = JSON.parse(body).itemdata
            for (var property in result) {
                if (result.hasOwnProperty(property)) {
                    items.insert(result[property]);
                }
            }

        }
    })
}

/**
 * Gets replay URL, either from steam or from database if we already have it
 */
function tryToGetReplayUrl(id, callback) {
    matches.findOne({match_id: id}, function(err, data){
        // Error occurred
        if (err) {
            callback(err)
        }
        // Already have the replay url
        if (data.replay_url) {
            callback(null, data.replay_url)
        } 
        else{
            if (steam.ready) {
                steam.getMatchDetails(id, function(err, data) {
                    if (!err && data) {
                        var result= {};
                        result.replay_url = util.format("http://replay%s.valve.net/570/%s_%s.dem.bz2", data.cluster, data.id, data.salt);
                        result.salt = data.salt
                        matches.update({match_id: id}, {$set: result}, function(){})
                        callback(null, replay.replay_url)
                    } 
                    else {
                        // Something went wrong
                        callback(true)
                    }
                })
            } 
            else {
                // Steam's not ready
                callback(true)
            }
        }
    })
}

/**
 * Downloads replay file from specified url
 */
function downloadAndParse(err, url) {
    if (err) return;
    var fileName = url.substr(url.lastIndexOf("/") + 1).slice(0,-4);
    var replayPath = "./replays/";
    var parserFile = process.env.PARSER_FILE || "./parser/target/stats-0.1.0.jar";
    if (!fs.existsSync(replayPath+fileName)){
        logger.log('info', 'Trying to download file from %s', url)
        http.get(url, function(res) {
            if (res.statusCode !== 200) {
                logger.log("warn", "[DL] failed to download %s", fileName)
                return;
            }
            
            var data = [], dataLen = 0; 

            res.on('data', function(chunk) {
                data.push(chunk);
                dataLen += chunk.length;
            }).on('end', function() {
                var buf = new Buffer(dataLen);

                for (var i=0, len = data.length, pos = 0; i < len; i++) { 
                    data[i].copy(buf, pos); 
                    pos += data[i].length; 
                } 

                var Bunzip = require('seek-bzip');
                var decompressed = Bunzip.decode(buf);
                logger.log('info', '[DL] writing decompressed file');
                fs.writeFileSync(replayPath + fileName, decompressed); 

                //separate into new function
                logger.log('info', "[PARSER] starting parse: %s", fileName);
                var cp = spawn(
                    "java",
                    ["-jar",
                     parserFile,
                     replayPath + fileName
                    ]
                );

                cp.stdout.on('data', function (data) {
                    //parsed result should go here
                    //insert data from stdout into database
                    logger.log('info', '[PARSER] stdout: %s - %s', data, fileName);
                });

                cp.stderr.on('data', function (data) {
                    //informational data should go here
                    logger.log('error', '[PARSER] stderr: %s - %s', data, fileName);
                });

                cp.on('close', function (code) {
                    logger.log('info', '[PARSER] exited with code %s - %s', code, fileName);
                });      
            });
        });    
    }
}


function getMatches() {
    //add a trackedUsers database to determine users to follow
    var account_ids = ["102344608", "88367253"];
    account_ids.forEach(function(id, i) {
        requestGetMatchHistory(id, 2);
    });
    parseNewReplays();
}

function parseNewReplays() {
    logger.log('info', 'Parsing replays for new matches.');
    // Currently identifies unparsed games by playerNames field
    //get only games within the last 7 days, otherwise replay expired
    matches.find({"playerNames": {$exists:false}}, {"sort": ['match_id', 'desc'], "limit": 10}, function(err, docs){
        if (err) throw err;
        else {
            logger.log('info', 'Found %s matches needing parse', docs.length);
            docs.forEach(function(doc, i) {
                //if !downloaded
                //download
                //check if replay file exists (download could fail if too new)
                //parse the replay
                setTimeout(tryToGetReplayUrl, i*5000, doc.match_id, downloadAndParse)
            })
        }
    });
}

module.exports = function run() {
    requestGetHeroes();
    requestGetItems();
    setInterval(getMatches, 15000) 
