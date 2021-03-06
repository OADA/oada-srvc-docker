const debug = require('debug');

const oadaLib = require('@oada/lib-arangodb');

const trace = debug('token-lookup:trace');
const info = debug('token-lookup:info');
const warn = debug('token-lookup:warn');
const error = debug('token-lookup:error');

module.exports = function tokenLookup(req) {
  const res = {
    type: 'http_response',
    token: req.token,
    token_exists: false,
    partition: req.resp_partition,
    connection_id: req.connection_id,
    doc: {
      authorizationid: null,
      user_id: null,
      scope: [],
      bookmarks_id: null,
      shares_id: null,
      client_id: null,
    },
  };

  if (typeof req.token === 'undefined') {
    trace('No token supplied with the request.');
    return Promise.resolve(res);
  }
  // Get token from db.  Later on, we should speed this up
  // by getting everything in one query.
  return oadaLib.authorizations
    .findByToken(req.token.trim().replace(/^Bearer /, ''))
    .then((t) => {
      let msg = Object.assign({}, res);

      if (!t) {
        warn('WARNING: token ' + req.token + ' does not exist.');
        msg.token = null;
        return msg;
      }

      if (!t._id) {
        warn('WARNING: _id for token does not exist in response');
      }

      if (!t.user) {
        info(`user for token ${t.token} not found`);
        t.user = {};
      }

      if (!t.user.bookmarks) {
        info(`No bookmarks for user from token ${t.token}`);
        t.user.bookmarks = {};
      }

      t.expired = false;
      if (t.expiresIn && t.createTime) {
        const now = new Date();
        if (now > t.createTime + t.expiresIn) {
          info('Token is expired');
          t.expired = true;
        }
        trace(
          'token.createTime = %s, t.expiresIn = %s, now = %s',
          t.createTime,
          t.expiresIn,
          now
        );
      }
      trace('token expired? %s', t.expired);

      msg.token_exists = true;
      trace('received authorization, _id = %s', t._id);
      msg.doc.authorizationid = t._id;
      msg.doc.client_id = t.clientId;
      msg.doc.user_id = t.user._id || msg.doc.user_id;
      msg.doc.bookmarks_id = t.user.bookmarks._id || msg.doc.bookmarks_id;
      msg.doc.shares_id = t.user.shares._id || msg.doc.shares_id;
      msg.doc.scope = t.scope || msg.doc.scope;
      msg.doc.expired = t.expired;

      return msg;
    })
    .catch((err) => {
      error(err);
      return res;
    });
};
