////////////// REQUIRES //////////////

var express = require('express');
var app = express();
var http = require('http');
var bodyParser = require('body-parser');
// var cookieParser = require('cookie-parser');
var path = require('path');
var mysql = require('mysql');
var AWS = require('aws-sdk');
var session = require('express-session');
var RedisStore = require('connect-redis')(session);
var passport = require('passport');
var saml = require('passport-saml');
require('dotenv').load();  //loads the local environment
var biblemesh_util = require('./routes/biblemesh_util');


////////////// SETUP SERVER //////////////

var port = parseInt(process.env.PORT, 10) || process.env.PORT || 8080;
app.set('port', port);
var server = http.createServer(app);
var appURL = process.env.APP_URL || "https://read.biblemesh.com";
var log = function(msgs, importanceLevel) {
  var logLevel = parseInt(process.env.LOGLEVEL) || 3;   // 1=verbose, 2=important, 3=errors only
  importanceLevel = importanceLevel || 1;
  if(importanceLevel >= logLevel) {
    if(!Array.isArray(msgs)) msgs = [msgs];
    msgs.unshift(['LOG ','INFO','ERR '][importanceLevel - 1]);
    console.log.apply(this, msgs);
  }
}

////////////// SETUP STORAGE //////////////

var s3 = new AWS.S3();

var connection = mysql.createConnection({
  host: process.env.RDS_HOSTNAME,
  port: process.env.RDS_PORT,
  user: process.env.RDS_USERNAME,
  password: process.env.RDS_PASSWORD,
  database: process.env.RDS_DB_NAME,
  multipleStatements: true,
  dateStrings: true
})

var redisOptions = {
  host: process.env.REDIS_HOSTNAME,
  port: process.env.REDIS_PORT
}


////////////// SETUP PASSPORT //////////////

var filterBookIdsByIDPs = function(bookIds, idpCodes, isAdmin, next, callback) {

  // Admins not counted as admins if they are logged into multiple IDPs
  isAdmin = isAdmin && idpCodes.length==1;

  // filter bookIds by the book-idp (books are accessible to user only if the book is associated with login IDP)
  connection.query('SELECT book_id FROM `book-idp` WHERE idp_code IN(?)' + (isAdmin ? '' : ' AND book_id IN(?)'),
    [idpCodes.concat(['']), bookIds.concat([-1])],
    function (err, rows, fields) {
      if (err) return next(err);

      var idpBookIds = rows.map(function(row) { return parseInt(row.book_id); });
      log(['Filter book ids by idp', idpBookIds]);
      
      callback(
        isAdmin
          ? idpBookIds
          : bookIds.filter(function(bId) { return idpBookIds.indexOf(bId) != -1; })
      );
    }
  );
}

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

var authFuncs = {};

var strategyCallback = function(idp, profile, done) {
  log(['Profile from idp', profile], 2);

  var mail = profile['urn:oid:0.9.2342.19200300.100.1.3'];
  var idpUserId = profile['idpUserId'];
  var isAdmin = !!profile['isAdmin'] || process.env.ADMIN_EMAILS.toLowerCase().split(' ').indexOf(mail.toLowerCase()) != -1;
  var givenName = profile['urn:oid:2.5.4.42'] || '';
  var sn = profile['urn:oid:2.5.4.4'] || '';
  var bookIds = ( profile['bookIds'] ? profile['bookIds'].split(' ') : [] )
    .map(function(bId) { return parseInt(bId); });

  if(!mail || !idpUserId) {
    log(['Bad login', profile], 3);
    done('Bad login.');
  }

  filterBookIdsByIDPs(bookIds, [idp.code], isAdmin, done, function(filteredBookIds) {

    bookIds = filteredBookIds;

    var completeLogin = function(userId) {
      log('Login successful', 2);
      done(null, Object.assign(profile, {
        id: userId,
        email: mail,
        firstname: givenName,
        lastname: sn,
        bookIds: bookIds,
        isAdmin: isAdmin,  // If I change to multiple IDP logins at once, then ensure admins can only be logged into one
        idpCode: idp.code,
        idpName: idp.name,
        idpLogoSrc: idp.logoSrc,
        idpSmallLogoSrc: idp.smallLogoSrc || idp.logoSrc,
        idpLang: idp.language || 'en'
      }));
    }

    connection.query('SELECT id FROM `user` WHERE user_id_from_idp=? AND idp_code=?',
      [idpUserId, idp.code],
      function (err, rows) {
        if (err) return done(err);

        var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();

        if(rows.length == 0) {
          log('Creating new user row');
          connection.query('INSERT into `user` SET ?',
            {
              user_id_from_idp: idpUserId,
              idp_code: idp.code,
              email: mail,
              last_login_at: currentMySQLDatetime
            },
            function (err2, results) {
              if (err2) return done(err2);

              log('User row created successfully');
              completeLogin(results.insertId);
            }
          );

        } else {
          log('Updating new user row');
          connection.query('UPDATE `user` SET last_login_at=?, email=? WHERE user_id_from_idp=? AND idp_code=?',
            [currentMySQLDatetime, mail, idpUserId, idp.code],
            function (err2, results) {
              if (err2) return done(err2);

              log('User row updated successfully');
              completeLogin(rows[0].id);
            }
          );
        }
      }
    )
  });
};

// setup SAML strategies for IDPs
connection.query('SELECT * FROM `idp`',
  function (err, rows) {
    if (err) {
      log(["Could not setup IDPs.", err], 3);
      return;
    }

    rows.forEach(function(row) {
      var samlStrategy = new saml.Strategy(
        {
          issuer: appURL + "/shibboleth",
          identifierFormat: null,
          validateInResponseTo: false,
          disableRequestedAuthnContext: true,
          callbackUrl: appURL + "/login/" + row.code + "/callback",
          entryPoint: row.entryPoint,
          logoutUrl: row.logoutUrl,
          logoutCallbackUrl: appURL + "/logout/callback",
          cert: row.idpcert,
          decryptionPvk: row.spkey,
          privateCert: row.spkey
        },
        function(profile, done) {
          strategyCallback(row, profile, done);
        }
      );

      passport.use(row.code, samlStrategy);

      authFuncs[row.code] = {
        getMetaData: function() {
          return samlStrategy.generateServiceProviderMetadata(row.spcert);
        },
        logout: function(req, res, next) {
          log(['Logout', req.user], 2);
          if(req.user.nameID && req.user.nameIDFormat) {
            log('Redirect to SLO');
            samlStrategy.logout(req, function(err2, req2){
              if (err2) return next(err2);

              log('Back from SLO');
              //redirect to the IdP Logout URL
              res.redirect(req2);
            });
          } else {
            log('No call to SLO', 2);
            res.redirect("/logout/callback");
          }
        }
      }

    });
  }
);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  } else if (process.env.SKIP_AUTH) {
    filterBookIdsByIDPs([], ['bm'], true, next, function(filteredBookIds) {
      req.user = {
        id: 1,
        email: 'place@holder.com',
        firstname: 'Jim',
        lastname: 'Smith',
        bookIds: filteredBookIds,
        isAdmin: true,
        idpCode: 'bm',
        idpName: 'BibleMesh',
        idpLogoSrc: 'https://s3-us-west-2.amazonaws.com/biblemesh-static/biblemesh-logo.png',
        idpSmallLogoSrc: 'https://s3-us-west-2.amazonaws.com/biblemesh-static/biblemesh-logo-small.png',
        idpLang: 'en'
      }
      return next();
    });
  } else if(
    req.method == 'GET'
    && (
      req.headers['app-request']
      && req.originalUrl.match(/^\/usersetup\.json/)
    ) || (
      req.originalUrl.match(/^\/(book\/[^\/]*|\?.*)?$/)
    )
  ) {  // library or book call
    if(req.query.widget) {
      return res.send(`
        <script>
          parent.postMessage({
              action: 'forbidden',
              iframeid: window.name,
              payload: 'Unable to display book. You are not logged in.',
          }, '*');
        </script>
      `);
    }
    log('Redirecting to authenticate', 2);
    req.session.loginRedirect = req.url;
    if(req.headers['app-request']) {
      req.session.cookie.maxAge = parseInt(process.env.APP_SESSION_MAXAGE);
      log(['Max age to set on cookie', req.session.cookie.maxAge]);
    }
    return res.redirect('/login');
  } else {
    return res.status(403).send({ error: 'Please login' });
  }
}


////////////// MIDDLEWARE //////////////

// see http://stackoverflow.com/questions/14014446/how-to-save-and-retrieve-session-from-redis

// app.use(cookieParser());
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  store: new RedisStore(redisOptions),
  secret: process.env.SESSION_SECRET || 'secret',
  saveUninitialized: false,
  resave: false,
  cookie : { httpOnly: true, maxAge: parseInt(process.env.SESSION_MAXAGE) } // configure when sessions expires
}));
app.use(passport.initialize());
app.use(passport.session());


////////////// ROUTES //////////////

// force HTTPS
app.use('*', function(req, res, next) {  
  if(!req.secure && req.headers['x-forwarded-proto'] !== 'https' && process.env.REQUIRE_HTTPS) {
    log('Go to HTTPS');
    var secureUrl = "https://" + req.headers['host'] + req.url; 
    res.redirect(secureUrl);
  } else {
    next();
  }
});

// route RequireJS_config.js properly (for dev)
app.get(['/RequireJS_config.js', '/book/RequireJS_config.js'], function (req, res) {
  res.sendFile(path.join(process.cwd(), 'dev/RequireJS_config.js'));
})

require('./routes/biblemesh_routes')(app, s3, connection, passport, authFuncs, ensureAuthenticated, log);


////////////// LISTEN //////////////

server.listen(port);
