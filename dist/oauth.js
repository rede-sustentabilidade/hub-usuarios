'use strict';

var oauth2orize = require('oauth2orize'),
    passport = require('passport'),
    db = require('./db'),
    crypto = require('crypto'),
    utils = require("./utils"),
    bcrypt = require('bcrypt');

// create OAuth 2.0 server
var server = oauth2orize.createServer();

//(De-)Serialization for clients
server.serializeClient(function (client, done) {
	return done(null, client.client_id);
});

server.deserializeClient(function (id, done) {
	var countQuery = db.query('\n\t\tSELECT oc.name, oc.client_id, oc.client_secret, oc.redirect_uri from rs.oauth_clients oc\n\t\twhere oc.client_id = $1;\n\t', [id]);

	countQuery.on('error', done);
	countQuery.on('row', function (row) {
		if (Object.keys(row).length < 1) {
			res.send("Client ID not found.").status(404);
		} else {
			done(null, row);
		}
	});
});

//Implicit grant
// server.grant(oauth2orize.grant.token(function (client, user, ares, done) {
//     let token = utils.uid(256),
//     	tokenHash = crypto.createHash('sha1').update(token).digest('hex'),
//     	expirationDate = new Date(new Date().getTime() + (3600 * 1000)),
// 		query = db.query(`
// 		INSERT INTO rs.oauth_access_tokens(access_token, client_id, user_id, expires)
// 			VALUES ($1, $2, $3, $4);
// 		`, [tokenHash, client.client_id, user.id, expirationDate], (err, result) => {
// 			if (err) return done(err)
// 			return done(null, token, {expires_in: expirationDate.toISOString()})
// 		})
// }))

//Register grant (used to issue authorization codes)
server.grant(oauth2orize.grant.code(function (client, redirectURI, user, ares, done) {
	var code = utils.uid(16);
	var codeHash = crypto.createHash('sha1').update(code).digest('hex');
	var query = db.query('\n\t\tINSERT INTO rs.oauth_authorization_codes(code, client_id, user_id, redirect_uri)\n\t\t\tVALUES ($1, $2, $3, $4);\n\t\t', [codeHash, client.client_id, user.id, redirectURI], function (err, result) {
		if (err) return done(err);
		return done(null, codeHash);
	});
}));

//Used to exchange authorization codes for access token
server.exchange(oauth2orize.exchange.code(function (client, code, redirectURI, done) {
	var search_auth_code = db.query('\n\t\tSELECT ac.code, ac.client_id, ac.user_id, ac.redirect_uri\n\t\tFROM rs.oauth_authorization_codes ac\n\t\tWHERE ac.code = $1 and ac.client_id = $2\n\t', [code, client.client_id]);
	search_auth_code.on('error', done);
	search_auth_code.on('row', function (row) {
		console.log(row);
		if (Object.keys(row).length < 1) {
			done(null, false);
		} else if (row.redirect_uri !== redirectURI) {
			done(null, false);
		}

		var remove_auth_code = db.query('\n\t\t\tDELETE from rs.oauth_authorization_codes WHERE code = $1\n\t\t\t', [code], function (err, result) {
			if (err) return done(err);
			var token = utils.uid(256);
			var refreshToken = utils.uid(256);
			var tokenHash = crypto.createHash('sha1').update(token).digest('hex');
			var refreshTokenHash = crypto.createHash('sha1').update(refreshToken).digest('hex');
			var expirationDate = new Date(new Date().getTime() + 3600 * 1000);

			var create_token = db.query('\n\t\t\t\tINSERT INTO rs.oauth_access_tokens(access_token, client_id, user_id, expires)\n\t\t\t\t\tVALUES ($1, $2, $3, $4);\n\t\t\t\t', [tokenHash, client.client_id, row.user_id, expirationDate], function (err2, result2) {
				if (err2) return done(err2);

				var query3 = db.query('\n\t\t\t\t\tINSERT INTO rs.oauth_refresh_tokens(refresh_token, client_id, user_id, expires)\n\t\t\t\t\t\tVALUES ($1, $2, $3, $4);\n\t\t\t\t\t', [refreshTokenHash, client.client_id, row.user_id, expirationDate], function (err3, result3) {
					if (err3) return done(err3);
					done(null, token, refreshToken, { expires_in: expirationDate });
				});
			});
		});
	});
}));

//Refresh Token
server.exchange(oauth2orize.exchange.refreshToken(function (client, refreshToken, scope, done) {
	var refreshTokenHash = crypto.createHash('sha1').update(refreshToken).digest('hex');
	db.collection('refreshTokens').findOne({ refreshToken: refreshTokenHash }, function (err, token) {
		if (err) return done(err);
		if (!token) return done(null, false);
		if (client.clientId !== token.clientId) return done(null, false);

		var newAccessToken = utils.uid(256);
		var accessTokenHash = crypto.createHash('sha1').update(newAccessToken).digest('hex');

		var expirationDate = new Date(new Date().getTime() + 3600 * 1000);

		db.collection('accessTokens').update({ userId: token.userId }, { $set: { token: accessTokenHash, scope: scope, expirationDate: expirationDate } }, function (err) {
			if (err) return done(err);
			done(null, newAccessToken, refreshToken, { expires_in: expirationDate });
		});
	});
}));

// user authorization endpoint
exports.authorization = [function (req, res, next) {
	if (req.user) {
		next();
	} else {
		res.redirect('/oauth/authorization?' + 'client_id=' + req.query.client_id + '&redirect_uri=' + req.query.redirect_uri + '&response_type=' + req.query.response_type);
	}
}, server.authorization(function (client_id, redirect_uri, done) {
	console.log(client_id, redirect_uri);
	var countQuery = db.query('\n\t\t\tSELECT oc.name, oc.client_id, oc.client_secret, oc.redirect_uri from rs.oauth_clients oc\n\t\t\twhere oc.client_id = $1 and oc.redirect_uri = $2;\n\t\t', [client_id, redirect_uri], function (err, results) {
		if (err) done(err);
		if (results.rows.length < 0) {
			res.send("Client ID not found.").status(404);
		} else {
			var row = results.rows[0];
			done(null, row, redirect_uri);
		}
	});
	countQuery.on('error', done);
}), function (req, res) {
	res.render('decision', { transactionID: req.oauth2.transactionID, user: req.user, client: req.oauth2.client });
}];

// user decision endpoint

exports.decision = [function (req, res, next) {
	if (req.user) {
		next();
	} else {
		res.redirect('/oauth/authorization?' + 'client_id=' + req.query.client_id + '&redirect_uri=' + req.query.redirect_uri + '&response_type=' + req.query.response_type);
	}
}, server.decision()];
// token endpoint
exports.token = [function (req, res, next) {
	next();
}, passport.authenticate(['clientBasic', 'clientPassword'], { session: false }), server.token(), server.errorHandler()];