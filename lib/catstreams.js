/*
 * lib/catstreams.js: concatenate results of multiple stream objects
 */

var mod_assert = require('assert');
var mod_util = require('util');
var mod_stream = require('stream');

/*
 * Use shim for Node v0.8 if necessary.
 */
if (!mod_stream.PassThrough)
	mod_stream = require('readable-stream');

var mod_vasync = require('vasync');


/* Public interface */
module.exports = CatStreams;


/*
 * Custom stream implementation that concatenates the contents of multiple
 * other streams, which are fetched concurrently (but emitted in order).  The
 * configuration object contains three properties:
 *
 *    log		a bunyan-style logger
 *
 *    perRequestBuffer	max amount of data to buffer for each concurrent stream
 *
 *    maxConcurrency	max number of streams outstanding
 *
 * To append a resource, callers invoke cat(func), where "func" will be
 * invoked as "cat(callback)", where "callback" should be invoked with an error
 * or the stream to be appended.  For example, "func" might make an HTTP
 * client request and invoke "callback" with the response object.
 *
 * If "func" is null, the stream will accept no more "cat" requests and will
 * emit the 'end' event when all previously submitted requests have completed.
 *
 *
 * IMPLEMENTATION NOTES
 *
 * There are two common workloads for this stream:
 *
 *    (1) The input is a large sequence of tiny objects.  For this use case,
 *        fetching resources in parallel and buffering when needed significantly
 *        improves both throughput and overall latency to read the stream.
 *
 *    (2) The input is any sequence of large objects.  For this use case,
 *        prefetching and buffering are less significant, since the request
 *        overhead is less significant for throughput and overall latency.  This
 *        use case requires that we be mindful of how much data we buffer, since
 *        if we took the same approach as for (1), we could end up buffering
 *        lots of data.
 */
function CatStreams(options)
{
	mod_assert.ok(options.hasOwnProperty('log', 'log is required'));
	mod_assert.ok(options.hasOwnProperty('perRequestBuffer',
	    'perRequestBuffer is required'));
	mod_assert.ok(options.hasOwnProperty('maxConcurrency',
	    'maxConcurrency is required'));

	/* helper objects */
	this.cs_log = options['log'];
	this.cs_hiwat = options['perRequestBuffer'];
	this.cs_maxconcurr = options['maxConcurrency'];
	this.cs_queue = mod_vasync.queuev({
	    'concurrency': this.cs_maxconcurr,
	    'worker': this.work.bind(this)
	});

	this.cs_ended = false;		/* stream has been ended */
	this.cs_ready = [];		/* streams being fetched, in order */
	this.cs_nqueued = 0;		/* count of resources queued */
	this.cs_nstarted = 0;		/* count of resources started */
	this.cs_ndone = 0;		/* count of resources done */

	mod_stream.PassThrough.call(this);
}

mod_util.inherits(CatStreams, mod_stream.PassThrough);

CatStreams.prototype.cat = function (func)
{
	var rq;

	if (this.cs_ended)
		throw (new Error('stream has already been ended'));

	if (func !== null) {
		rq = { 'func': func };
		this.cs_log.trace('enqueuing resource: %j', rq);
		this.cs_queue.push(rq);
		this.cs_nqueued++;
		return;
	}

	this.cs_log.info('input stream ended');
	this.cs_ended = true;

	if (this.cs_queue.length() === 0 && this.cs_queue.npending === 0)
		this.end();
};

CatStreams.prototype.work = function (rq, callback)
{
	this.cs_nstarted++;
	this.cs_ready.push(rq);

	rq['stream'] = rq['func']({ 'highWaterMark': this.cs_hiwat });
	rq['stream'].on('end', callback);
	rq['stream'].read(0);

	if (this.cs_ready.length == 1)
		this.pipeHead();
};

CatStreams.prototype.pipeHead = function ()
{
	mod_assert.ok(this.cs_ready.length > 0);

	var s = this;
	var rq = this.cs_ready[0];

	rq['stream'].pipe(this, { 'end': false });
	rq['stream'].on('end', function () {
		mod_assert.ok(s.cs_ready[0] == rq);
		s.cs_ready.shift();
		s.cs_ndone++;

		if (s.cs_ready.length > 0)
			s.pipeHead();
		else if (s.cs_ended && s.cs_queue.length() === 0 &&
		    s.cs_queue.npending === 0)
			s.end();
	});
	rq['stream'].on('error', this.emit.bind(this, 'error'));
};