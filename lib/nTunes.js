require.paths.unshift(__dirname);
var fs = require("fs");
var sys = require("sys");
var Url = require("url");
var querystring = require("querystring");
var Buffer = require("buffer").Buffer;
var connect = require("connect");
var xml2js = require('xml2js');
var applescript = require("applescript");
var nClass = require("nTunes-class");
var nCommand = require("nTunes-command");
var nSpecifier = require("nTunes-specifier");
require.paths.shift();


// Before doing anything, let's import the "iTunes.sdef" file. The free
// variable 'SDEF' will contain the parsed object, which is used to
// dynamically build the nTunes API.
var parser = new xml2js.Parser();
  
parser.on('end', function(result) {
  // With the parsed XML result, we need to format the object into
  // nClass and nCommand instances.
  var iTunesSuite = result.suite[1];
  nCommand.processCommands(iTunesSuite.command);
  nClass.processClasses(iTunesSuite['class']);
  nSpecifier.setNClass(nClass);
  
  parser = null;
});
fs.readFile(__dirname + '/iTunes.sdef', function(err, data) {
  parser.parseString(data);
});




// The 'nTunes' constructor is a full subclass of 'connect', but allows the
// ability to add aditional layers in front of the nTunes layers, in case you
// would like to serve other content on urls not in use by nTunes (be careful!)
function nTunes(layers) {
  var self = this;
  
  // Concat nTunes layers to the end of 'layers' here
  layers = layers.concat([
    function(req, res, next) {
      self.ensureSdefIsProcessed(req, res, next);
    },
    //function(req, res, next) {
      //self.handleNTunesAliases(req, res, next);
    //},
    function(req, res, next) {
      self.handleNTunesRequest(req, res, next);
    }
  ]);

  // Call the 'connect' Server constructor, to complete the subclassing.
  connect.Server.call(self, layers);
}

// Public API can use 'nTunes.createServer' for familiarity with the connect
// and http modules, or simply use the 'nTunes' module as a constructor.
nTunes.createServer = function() {
  return new nTunes(Array.prototype.slice.call(arguments));
}

// For the most flexibility, pass this object in your middleware stack to
// represent where the nTunes layers go overall in the stack. This allows
// the end user to put layers both before and after the nTunes layers with
// the most flexibiltiy.
nTunes.LAYERS = {
  "id": "pass this in your middleware stack, represents the nTunes layer stack"
};

// Don't use `sys.inherits`, since it might be removed. Inherit from the
// prototype of 'connect.Server'.
nTunes.prototype = Object.create(connect.Server.prototype, {
  constructor: {
    value: nTunes,
    enumerable: false
  }
});


nTunes.prototype.doNTunesCommand = function(command, params, res, url) {
  var ncommand = nCommand.getCommand(command);
  var asStr = command + ' ';
  var self = this;
  
  ncommand.parameters.forEach(function(parameter) {
    var userDidSupplyParam = parameter.name in params;
    if (!userDidSupplyParam && !parameter.optional) {
      // Return error, user did not supply required param
    }
    if (userDidSupplyParam) {
      if (parameter.name != "value") {
        asStr += parameter.name + " ";
      }
      if (parameter.type == "specifier") {
        var specifier = new nSpecifier(params[parameter.name]);
        asStr = specifier.toAppleScript() + '\n' + asStr + specifier.currentVar;
      } else if (parameter.type == "boolean") {
        asStr += String(params[parameter.name]).toLowerCase() == "true" ? "yes" : "no";
      }
      asStr += " ";
    }
  });
  
  self.doAppleScriptThenResponse(asStr, res);
}

// The first handler ensures that the .sdef XML file has been processed,
// and if it hasn't, it waits for it to finish before calling "next()".
nTunes.prototype.ensureSdefIsProcessed = function(req, res, next) {
  if (parser) {
    parser.on('end', function(result) {
      // Wait a tiny amount of time to ensure that the parsing handler
      // is the first 'end' handler for the parser.
      setTimeout(function() {
        next();
      }, 10);
    });
  } else {
    next();
  }
}


// The primary handler for the nTunes API. 
nTunes.prototype.handleNTunesRequest = function(req, res, next) {
  var self = this,
    isValidApiRequest = false;
  req.parsedUrl = res.parsedUrl = Url.parse(req.url, true);
  
  req.parsedUrl.decodedPath = decodeURIComponent(req.parsedUrl.pathname);
  
  // Each "/" in the request URI represents selecting a resource, narrowing
  // down the previous selection, or possibly calling a command.
  req.parsedUrl.request = req.parsedUrl.decodedPath.split("/").slice(1);
  
  // First check for the case of a "command", since it's only valid with a
  // single token in the URI, and a POST method request.
  if (req.method == "POST" && req.parsedUrl.request.length == 1 && nCommand.REGEXP.test(req.parsedUrl.request[0])) {
    isValidApiRequest = true;
    
    var body = "";
    req.setEncoding("utf8");
    req.on("data", function(chunk) {
      body += chunk;
    });
    req.on("end", function() {
      req.body = querystring.parse(decodeURIComponent(body));
      self.doNTunesCommand(req.parsedUrl.request[0], req.body, res, url);
    });
  }

  // If it's not a command, then maybe it's a class/property lookup.
  try {
    var resolvedSpecifier = new nSpecifier(req.parsedUrl.decodedPath);
    isValidApiRequest = true;
    
    var as = resolvedSpecifier.toAppleScript();
    
    if (req.method == "POST") {
      var body = "";
      req.setEncoding("utf8");
      req.on("data", function(chunk) {
        body += chunk;
      });
      req.on("end", function() {
        req.body = querystring.parse(decodeURIComponent(body));
        as += "set " + resolvedSpecifier.property + " of " + resolvedSpecifier.currentVar + " to " + req.body.value + "\n";
        as += "return " + resolvedSpecifier.property + " of " + resolvedSpecifier.currentVar;
        self.doAppleScriptThenResponse(as, res);
      });

      
    } else if (req.method == "GET") {
      as += "return " + resolvedSpecifier.property + " of " + resolvedSpecifier.currentVar;
      self.doAppleScriptThenResponse(as, res);
    }
    
  } catch (e) {
    // If resolveSpecifier throws an error, then the user requested
    // an invalid specifier. nTunes should respond with a 400 status
    // code and an Error object.
    self.sendNTunesResponse(res, 400, null, {
      error: e
    });
  }
  
  if (!isValidApiRequest) {
    next();
  }
}

// Performs the passed AppleScript code against the "iTunes" application,
// then sends the response from AppleScript to the HTTP client, ending
// the request.
nTunes.prototype.doAppleScriptThenResponse = function(as, res) {
  var self= this;
  as = 'tell application "iTunes"\n' + as + "\nend tell";
  applescript.execString(as, function(err, stdout, stderr) {
    if (err) {
      var e = new Error(stderr);
      e.code = err;
      self.sendNTunesResponse(res, 500, null, {
        error: e
      });
    } else {
      self.sendNTunesResponse(res, 200, null, stdout);
    }
  });
}

// Called whenever the nTunes API is ready to send a response to the client.
// It's a single shared function so that we can do last minute things like
// convert the data to a different transfer format if the client requested.
//   i.e. checks for ?format=xml to convert to XML
nTunes.prototype.sendNTunesResponse = function(res, code, headers, body) {
  var format = res.parsedUrl.query && res.parsedUrl.query.format ? res.parsedUrl.query.format : 'json';

  headers = headers || {};
  headers['Content-Type'] = FORMAT_TO_CONTENT_TYPE[format];
  
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
}

var FORMAT_TO_CONTENT_TYPE = {
  'json' : 'application/json',
  'xml': 'text/xml'
}

// Export the constructor itself since we're badass like that ☺
module.exports = nTunes;