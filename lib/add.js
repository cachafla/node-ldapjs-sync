/**
 * Copyright 2012 Yunong Xiao, Inc. All rights reserved.
 */

var common = require('./common');
var ldapjs = require('ldapjs');


// converts an add changelog to the actualy entry, check it against the dn and
// filter
function changelogToEntry(changelog, replContext, next) {
  var log = replContext.log;
  log.debug('entering changelogToEntry with %j', changelog.object);
  var entry = changelog.object.changes;
  var targetDn = ldapjs.parseDN(changelog.object.targetdn);
  var localDn = replContext.url.DN;
  var filter = replContext.url.filter;
  // parse the changes as json is the entry is stringified.
  if (typeof(entry) === 'string') {
    entry = JSON.parse(entry);
  }
  // cache the entry object
  changelog.remoteEntry = entry;

  if (localDn.parentOf(targetDn) || localDn.equals(targetDn)) {
    if(filter.matches(entry)) {
      log.debug('changelog %j matches filter and dn', changelog.object);
      return next();
    }
  }

  // otherwise, this entry doesn't match so skip straight to writing the checkpoint
  log.debug('changelog %j doesn\'t match filter or dn', changelog.object);
  return common.writeCheckpoint(changelog, replContext, function() {
    return next(true);
  });
}

function add(changelog, replContext, next) {
  var log = replContext.log;
  log.debug('entering add.add with %j', changelog.object);
  var localClient = replContext.localClient;
  var targetDn = changelog.object.targetdn;
  var entry = changelog.remoteEntry;
  // sneak in the url so we know where this replicated entry comes from.
  entry._url = replContext.url.href;
  console.log(changelog.remoteEntry);
  localClient.add(targetDn, entry, function(err, res) {
    if (err) {
      log.error('unable to write replicated entry', err);
      throw new Error('unable to write replicated entry %j', entry, err);
    }
    log.debug('successfully replicated add entry %j', entry);
    return next();
  });
}

///--- API

module.exports = {
  chain: function(handlers) {
    if (!handlers) {
      handlers = [];
    }

    [
      // handlers for add
      // Check checkpoint
      common.getCheckpoint,
      common.convertDn,
      // Convert from changelog entry to actualy entry
      // Match virtual entry against dn and filter
      changelogToEntry,
      // Add the entry
      add,
      // Write the new checkpoint
      common.writeCheckpoint
    ].forEach(function(h) {
      handlers.push(h);
    });

    return handlers;
  },

  // for unit tests
  changelogToEntry: changelogToEntry,
  add: add
};