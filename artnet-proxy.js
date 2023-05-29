const { program } = require('commander');

program.option('-d, --dst <dst-ip>', 'Destination IP to pass the traffic');

// todo: add heuristics to check from incoming packet stream how fast we should be pushing them out and use 1000 as minimum
program.option('-t, --throttle <packets-per-second>', 'Maximum number of output packets per second. This should be higher than incoming packets speed.', '1000');

program.parse();

const options = program.opts();

console.log(`Destination IP: ${options.dst}`);

const { ArtNetController } = require('artnet-protocol/dist');

// separate output controller since this lib seems to be pretty poopy
const destination_ip = options.dst;
const out = new ArtNetController();
out.bind(destination_ip);

// 0.0.0.0 address fails because artnet lib sets some address to undefined and
// it has internal bug...  port is always 6454
// for some reason this does not even listen packets incoming 127.0.0.1, but
// only sees packets broadcasted to localhost interface.. should have used 
// some better lib for this stuff 
const localhost_in = new ArtNetController();
localhost_in.bind('127.0.0.1');

// fix resolume sequence numbers (expecting no packet loss in localhost)
let sequence_num = 0;

// put packets here until they are sent out
const packet_queue = [];

// todo: this set of stats should be wrapped to a class
const report_interval_seconds = 5.0;
let incoming_bytes = 0;
let incoming_packets = 0;
let output_handler_calls = 0;
let output_action_calls = 0;
let output_packets_sent = 0;

// todo: add stats about minimum time between 2 packets. max is not so interesting.

setInterval(() => {
    console.log(`--------------------------------- ${new Date().toISOString()} -------------------------------------------`);
    console.log(`Incoming Bitrate: ${incoming_bytes * 8 / 1024.0 / report_interval_seconds} kbps ${incoming_packets / report_interval_seconds} packets/s`);
    console.log(`High speed "event loop" cycles: ${output_handler_calls / report_interval_seconds} calls/s Output packet send tries: ${output_action_calls / report_interval_seconds} calls/s`);
    console.log(`Output: ${output_packets_sent / report_interval_seconds} packets/s`);

    // reset stat counters
    incoming_bytes = 0;
    incoming_packets = 0;
    output_handler_calls = 0;
    output_action_calls = 0;
    output_packets_sent = 0;
    }, report_interval_seconds*1000);


//////////////////////////////////////////////////////////////////////////////
//
// Hand made fast event loop for deciding when to send next packet out. 
//
// setInterval / setTimeout does not really work for sub millisecond timings.
//

// calculate maximum interval that we are allowed to send packets
const min_wait_before_sending_next_packet_ns = 1000000000n / BigInt(options.throttle);

let next_output_time = process.hrtime.bigint() + min_wait_before_sending_next_packet_ns;

function outputHandlerLoop() {
    // schedule next check to place when loop is idle next time
    setImmediate(() => {
        output_handler_calls++;
        const current_time = process.hrtime.bigint();
        if (current_time > next_output_time) {
            next_output_time = current_time + min_wait_before_sending_next_packet_ns;
            output_action_calls++;
            const dmx = packet_queue.shift();
            if (dmx) {
                output_packets_sent++;
                // this lib does not even support sending non-broadcast packets
                // (maybe https://github.com/margau/dmxnet is better)
                out.sendBroadcastPacket(dmx);
            }
        }
        // do it again asap....
        outputHandlerLoop();
    });
}
outputHandlerLoop();

///////////////////////////////////////////////////////////////////////////////////////
//
// Listen incoming packets, add sequence numbering and push packets to output queue.
//

localhost_in.on('dmx', (dmx) => {
    incoming_bytes += dmx.data.length;
    incoming_packets += 1;

    // fix resolume packet sequence numbering
    sequence_num++;
    if (sequence_num > 255) {
        sequence_num = 1;
    }
    dmx.sequence = sequence_num;

    // just push it to the output queue
    packet_queue.push(dmx);
});
