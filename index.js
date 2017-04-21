_ = require('lodash');
var Twitter = require('twitter');
var WebSocket = require('ws');
var MongoClient = require('mongodb').MongoClient;
var mubsub = require('mubsub');
var filter = require('leo-profanity');
var Config = require('./config');
var http = require('http');
var https = require('https');

// how do you even use this
/*const isTweet = _.conforms({
  contributors: _.isObject,
  id_str: _.isString,
  text: _.isString
});*/

/**
 * getJSON:  REST get request returning JSON object(s)
 * @param options: http options object
 * @param callback: callback to pass the results JSON object(s) back
 */
var getJSON = function(options, onResult)
{
    console.log("rest::getJSON");

    var prot = options.port == 443 ? https : http;
    var req = prot.request(options, function(res)
    {
        var output = '';
        console.log(options.host + ':' + res.statusCode);
        res.setEncoding('utf8');

        res.on('data', function (chunk) {
            output += chunk;
        });

        res.on('end', function() {
            var obj = JSON.parse(output);
            onResult(res.statusCode, obj);
        });
    });

    req.on('error', function(err) {
        //res.send('error: ' + err.message);
    });

    req.end();
};


function isTweet(tweet) {
  if (_.isObject(tweet.contributors) && _.isString(tweet.id_str) && _.isString(tweet.text)) {
    return true;
  } else {
    return false;
  }
}

var mongo_client = mubsub('mongodb://localhost:27017/furthemore');
var channel = mongo_client.channel('pubsub');

var server = new WebSocket.Server({ port : Config.port });


filter.clearList()
      
MongoClient.connect('mongodb://localhost:27017/furthemore', function(err, db) {
  var collection = db.collection('profanity');
  var cursor = collection.find();
  cursor.toArray((err, items) => {
    items.forEach((item) => {
      if (item.type == 'blacklist') {
        filter.add(item.word);
      }
    });
    console.log(filter.list().length + " words loaded from profanity blacklist");
  });
});


server.broadcast = function broadcast(data) {
  server.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
};

//channel.publish('top5', { 'player' : 1, 'text' : 'Player 1' });
channel.subscribe('top5', function (message) {
  console.log("Update player:");
  console.log(message);
  server.broadcast(JSON.stringify({ 'type' : 'top5', 'message' : message }));
});

channel.subscribe('blacklist', function (message) {
  console.log("Blacklist word: " + message.word);
  server.broadcast(JSON.stringify({ 'type' : 'blacklist', 'word' : message.word }));
  filter.add(message.word);
});

channel.subscribe('whitelist', function (message) {
  console.log("Whitelist word: " + message.word);
  server.broadcast(JSON.stringify({ 'type' : 'whitelist', 'word' : message.word }));
  filter.remove(message.word);
});

channel.subscribe('marquee', function (message) {
  console.log("Update marquee:" + message.text);
  message.type = 'marquee';
  server.broadcast(JSON.stringify(message));
});

var client = new Twitter(Config.twitter);

var stream = client.stream('statuses/filter', { track : Config.follow });
stream.on('data', function(event) {
  //console.log(filter.list().length + " words loaded from profanity blacklist");
  if (event && 'text' in event) {
    if (!filter.check(event.text) && !filter.check(event.user.name) && !filter.check(event.user.screen_name)) {
      server.broadcast(JSON.stringify({ 'type' : 'tweet', 'tweet' : event }));
    } else {
      console.log("Skipped message with profanity: " + event.text);
    }
  } 
  //console.log(event);
});

stream.on('error', function(error) {
  console.log(error);
  //throw error;
});


server.on('connection', function connection(socket) {
  console.log("Connection...");

  socket.on('message', function incoming(data) {
    if (data == 'ping') {
      socket.send('pong');
      return;
    }
    console.log(data);

    try {
      args = JSON.parse(data);
    } catch (e) {
      args = { command: 'none' };
    }

    if (args.command == 'history') {
      // send dozen most recent tweets
      client.get('search/tweets', {q: Config.follow}, function(error, tweets, response) {
        tweets.statuses.reverse().forEach(function each(tweet) {
          if (!filter.check(tweet.text)) {
            socket.send(JSON.stringify({ 'type' : 'tweet', 'tweet' : tweet }));
          } else {
            console.log("Skipped message with profanity: " + tweet.text);
          }
        });
      });
    } else if (args.command == 'top5_history') {
      MongoClient.connect('mongodb://localhost:27017/furthemore', function(err, db) {
        var collection = db.collection('top5');
        var cursor = collection.find();
        cursor.toArray((err, items) => {
          items.forEach((item) => {
            socket.send(JSON.stringify({'type' : 'top5', 'message' : item }));       
          });
        });
        var collection = db.collection('marquee');
        var cursor = collection.find({'for' : 'twitter'});
        cursor.toArray((err, items) => {
          items.forEach((item) => {
            socket.send(JSON.stringify({'type' : 'marquee', 'for' : 'twitter', 'text' : item.text}));
          });
        });
      });
    } else if (args.command == 'trains') {
        update_trains(socket);
    }
  });
});


// WMATA stuff

var update_trains = function (socket) {
  var request_options = {
    host: 'api.wmata.com',
    port: 443,
    path: '/StationPrediction.svc/json/GetPrediction/N02',
    headers: { api_key : Config.wmata },
  };

  getJSON(request_options, function(statusCode, result) {
    socket.send(JSON.stringify({ 'type' : 'trains', 'trains' : result.Trains }));
  });
};

