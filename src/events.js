// ---------------------------------------------------------------
// Publishes goal events to the shared SNS topic (EVENTS_TOPIC_ARN).
// Each message carries the event type as a message attribute, so every
// SQS queue can subscribe with a filter and receive only what it handles.
//
// Envelope: { type, goalId, userId, at, data }
// Types:    goal.activated, goal.at_risk, goal.back_on_track,
//           goal.achieved, goal.abandoned, goal.reopened, goal.deleted
// ---------------------------------------------------------------
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

function createEvents({ topicArn = process.env.EVENTS_TOPIC_ARN, client } = {}) {
    if (!topicArn) {
        if (process.env.NODE_ENV === 'production') throw new Error('EVENTS_TOPIC_ARN is not set.');
        console.warn('EVENTS_TOPIC_ARN not set: events are only logged.');
        return { publish: async (type, goal) => console.log(`event ${type} ${goal.goalId}`) };
    }
    const sns = client || new SNSClient({});

    async function publish(type, goal, data = {}) {
        const message = { type, goalId: goal.goalId, userId: goal.userId, at: new Date().toISOString(), data };
        await sns.send(new PublishCommand({
            TopicArn: topicArn,
            Message: JSON.stringify(message),
            MessageAttributes: { eventType: { DataType: 'String', StringValue: type } }
        }));
    }

    return { publish };
}

module.exports = { createEvents };
