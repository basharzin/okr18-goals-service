// ---------------------------------------------------------------
// Input validation for goals. Only the fields named here are read;
// anything else in the body (id, userId, status, progress...) is ignored,
// because the server owns those values.
// ---------------------------------------------------------------

const { yearOf } = require('./rules');

const CATEGORIES = Object.freeze(['Health', 'Career', 'Learning', 'Finance', 'Personal', 'Other']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value, label, min, max, required) {
    if (value === undefined || value === null || value === '') {
        return required ? `${label} is required.` : null;
    }
    if (typeof value !== 'string') return `${label} must be text.`;
    const len = value.trim().length;
    if (len < min || len > max) return `${label} must be between ${min} and ${max} characters.`;
    return null;
}

function realDate(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;   // rejects 2026-02-31
}

// G7: the deadline must fall inside the goal's year and not be in the past
function checkDeadline(deadline, year, now) {
    if (!realDate(deadline)) return 'Deadline must be a real date written as YYYY-MM-DD.';
    if (Number(deadline.slice(0, 4)) !== year) return `Deadline must be inside ${year}.`;
    const today = now.toISOString().slice(0, 10);
    if (deadline < today) return 'Deadline cannot be in the past.';
    return null;
}

/**
 * New goal. Returns { errors: [...] } or { value: {...clean fields} }.
 * year: this year or next year only.
 */
function validateNewGoal(body, now) {
    const b = body || {};
    const errors = [];
    const thisYear = yearOf(now);

    const t = text(b.title, 'Title', 3, 80, true); if (t) errors.push(t);
    const d = text(b.description, 'Description', 0, 500, false); if (d) errors.push(d);
    if (!CATEGORIES.includes(b.category)) errors.push(`Category must be one of: ${CATEGORIES.join(', ')}.`);
    if (!Number.isInteger(b.year) || (b.year !== thisYear && b.year !== thisYear + 1)) {
        errors.push(`Year must be ${thisYear} or ${thisYear + 1}.`);
    } else {
        const dl = checkDeadline(b.deadline, b.year, now); if (dl) errors.push(dl);
    }

    if (errors.length) return { errors };
    return {
        value: {
            title: b.title.trim(),
            description: (b.description || '').trim(),
            category: b.category,
            year: b.year,
            deadline: b.deadline
        }
    };
}

/**
 * Edit. Only title, description, category and deadline can change.
 * At least one of them must be sent.
 */
function validateEdit(body, goal, now) {
    const b = body || {};
    const errors = [];
    const value = {};

    if ('title' in b) { const e = text(b.title, 'Title', 3, 80, true); e ? errors.push(e) : (value.title = b.title.trim()); }
    if ('description' in b) { const e = text(b.description, 'Description', 0, 500, false); e ? errors.push(e) : (value.description = (b.description || '').trim()); }
    if ('category' in b) { CATEGORIES.includes(b.category) ? (value.category = b.category) : errors.push(`Category must be one of: ${CATEGORIES.join(', ')}.`); }
    if ('deadline' in b) { const e = checkDeadline(b.deadline, goal.year, now); e ? errors.push(e) : (value.deadline = b.deadline); }

    if (!errors.length && Object.keys(value).length === 0) {
        errors.push('Send at least one of: title, description, category, deadline.');
    }
    return errors.length ? { errors } : { value };
}

// Query string filters for the list
function validateListQuery(query, now) {
    const q = query || {};
    const errors = [];
    const year = q.year === undefined ? yearOf(now) : Number(q.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('year must be a 4-digit year.');
    const statuses = ['Draft', 'Active', 'AtRisk', 'Achieved', 'Abandoned'];
    if (q.status !== undefined && !statuses.includes(q.status)) errors.push(`status must be one of: ${statuses.join(', ')}.`);
    if (q.category !== undefined && !CATEGORIES.includes(q.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}.`);
    return errors.length ? { errors } : { value: { year, status: q.status, category: q.category } };
}

const GOAL_ID = /^G-[0-9a-f-]{36}$/;
function isGoalId(id) { return typeof id === 'string' && GOAL_ID.test(id); }

module.exports = { CATEGORIES, validateNewGoal, validateEdit, validateListQuery, isGoalId };
