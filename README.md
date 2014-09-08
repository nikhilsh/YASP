YASP - YASP: Another Stats Page
====

An attempt to provide awesome replay-parsed stats for free!  

Requirements
====
* node.js v0.10
* Java 1.7
* Maven 3
* Foreman `npm install -g foreman`

Deployment directions
====
* Install node dependencies: `npm install`
* Export app to upstart `nf export -o /etc/init/`
* Create .env file with STEAM_USER, STEAM_PASS, STEAM_API_KEY
* Run `nf start`

Obtaining Replays
====
This application contains code from [matchurls](https://rjackson.me/tools/matchurls).  
It makes DOTA 2 API calls to get your most recently played games and downloads the replays.  
The replays are sent to a parser powered by [clarity](https://github.com/skadistats/clarity) to get interesting stats.  
Augmented match data is stored in MongoDB.

TODO
====
* Add mechanism for adding players to db
* Make match pages link to player page with teammate history and matches
* Make player names API request on page request, update/insert names
* Add tower/racks info
* Add hero position info
* Add rune info
* Add ward info
* Add chat log
* Add combat log
* Use multiple accounts to handle >100 replays/day
