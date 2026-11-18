// ---------------------------------------------------------------
// Goals data layer: the ONLY file that talks to the Goals table.
// Table:  GOALS_TABLE (key goalId)
// Index:  userId-year-index (partition userId, sort year)
// No access keys in the code: on Lambda the goals-role gives permission,
// on a PC the "floci" AWS profile does.
// ---------------------------------------------------------------
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand,
    UpdateCommand, DeleteCommand, ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const USER_YEAR_INDEX = 'userId-year-index';

function createGoalsRepo({ table = process.env.GOALS_TABLE, client } = {}) {
    if (!table) throw new Error('GOALS_TABLE is not set.');
    const db = client || DynamoDBDocumentClient.from(new DynamoDBClient({}));

    // Create: a new Draft goal (the controller builds the item)
    async function create(goal) {
        await db.send(new PutCommand({
            TableName: table,
            Item: goal,
            ConditionExpression: 'attribute_not_exists(goalId)'   // never overwrite
        }));
        return goal;
    }

    // Read one. Ownership is checked here: someone else's goal looks "not found".
    async function getOwned(goalId, userId) {
        const { Item } = await db.send(new GetCommand({ TableName: table, Key: { goalId } }));
        return Item && Item.userId === userId ? Item : null;
    }

    // Read one without an owner (internal calls from other services only)
    async function getById(goalId) {
        const { Item } = await db.send(new GetCommand({ TableName: table, Key: { goalId } }));
        return Item || null;
    }

    // Query: my goals for one year, optional filters on status and category
    async function listForUser(userId, { year, status, category }) {
        const names = { '#u': 'userId', '#y': 'year' };
        const values = { ':u': userId, ':y': year };
        const filters = [];
        if (status) { names['#s'] = 'status'; values[':s'] = status; filters.push('#s = :s'); }
        if (category) { names['#c'] = 'category'; values[':c'] = category; filters.push('#c = :c'); }

        const items = [];
        let ExclusiveStartKey;
        do {
            const page = await db.send(new QueryCommand({
                TableName: table,
                IndexName: USER_YEAR_INDEX,
                KeyConditionExpression: '#u = :u AND #y = :y',
                FilterExpression: filters.length ? filters.join(' AND ') : undefined,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
                ExclusiveStartKey
            }));
            items.push(...page.Items);
            ExclusiveStartKey = page.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return items;
    }

    // Count goals that use up one of the 5 active slots (G3)
    async function countActive(userId, year) {
        const all = await listForUser(userId, { year });
        return all.filter((g) => g.status === 'Active' || g.status === 'AtRisk').length;
    }

    // Update: edit fields, only while the status is still the one we checked
    async function updateFields(goalId, userId, fields, expectedStatus, nowIso) {
        const names = { '#owner': 'userId', '#s': 'status', '#upd': 'updatedAt' };
        const values = { ':owner': userId, ':expected': expectedStatus, ':upd': nowIso };
        const sets = ['#upd = :upd'];
        Object.entries(fields).forEach(([k, v], i) => {
            names[`#f${i}`] = k; values[`:f${i}`] = v; sets.push(`#f${i} = :f${i}`);
        });
        return conditionalUpdate({
            Key: { goalId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: '#owner = :owner AND #s = :expected',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values
        });
    }

    // Update: change status. The condition makes two clicks at once safe:
    // only the first one finds the status it expected.
    async function changeStatus(goalId, { from, to, extra = {}, nowIso, userId }) {
        const names = { '#s': 'status', '#upd': 'updatedAt' };
        const values = { ':from': from, ':to': to, ':upd': nowIso };
        const sets = ['#s = :to', '#upd = :upd'];
        Object.entries(extra).forEach(([k, v], i) => {
            names[`#x${i}`] = k; values[`:x${i}`] = v; sets.push(`#x${i} = :x${i}`);
        });
        let condition = '#s = :from';
        if (userId) { names['#owner'] = 'userId'; values[':owner'] = userId; condition += ' AND #owner = :owner'; }
        return conditionalUpdate({
            Key: { goalId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values
        });
    }

    // Delete: only Draft or Abandoned, and only the owner's (G8)
    async function remove(goalId, userId) {
        try {
            await db.send(new DeleteCommand({
                TableName: table,
                Key: { goalId },
                ConditionExpression: '#owner = :owner AND (#s = :d OR #s = :a)',
                ExpressionAttributeNames: { '#owner': 'userId', '#s': 'status' },
                ExpressionAttributeValues: { ':owner': userId, ':d': 'Draft', ':a': 'Abandoned' }
            }));
            return true;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return false;
            throw error;
        }
    }

    // Scan: every goal in play, for the daily health job (coursework scale)
    async function listInPlay() {
        const items = [];
        let ExclusiveStartKey;
        do {
            const page = await db.send(new ScanCommand({
                TableName: table,
                FilterExpression: '#s = :a OR #s = :r',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':a': 'Active', ':r': 'AtRisk' },
                ExclusiveStartKey
            }));
            items.push(...page.Items);
            ExclusiveStartKey = page.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return items;
    }

    async function conditionalUpdate(params) {
        try {
            const { Attributes } = await db.send(new UpdateCommand({ TableName: table, ReturnValues: 'ALL_NEW', ...params }));
            return Attributes;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return null;   // changed meanwhile
            throw error;
        }
    }

    return { create, getOwned, getById, listForUser, countActive, updateFields, changeStatus, remove, listInPlay };
}

module.exports = { createGoalsRepo, USER_YEAR_INDEX };
