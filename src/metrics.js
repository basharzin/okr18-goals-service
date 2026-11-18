// Writes one CloudWatch metric in the namespace OKR18/Goals.
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

function createMetrics({ client } = {}) {
    const cw = client || new CloudWatchClient({});
    return {
        async put(name, value) {
            try {
                await cw.send(new PutMetricDataCommand({
                    Namespace: 'OKR18/Goals',
                    MetricData: [{ MetricName: name, Value: value, Unit: 'Count' }]
                }));
            } catch (error) {
                // A metric must never break the job; the log line still has the number
                console.error(JSON.stringify({ service: 'goals', metricFailed: name, error: error.name }));
            }
        }
    };
}

module.exports = { createMetrics };
