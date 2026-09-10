const linearEndpoint = "https://api.linear.app/graphql";

let cachedTeamId = null;

async function getTeamId(teamKey) {
    if (cachedTeamId) {
        return cachedTeamId;
    }

    const query = `
        query {
            teams(filter: { key : { eq: "${teamKey}" } }) {
                nodes { id key }
            }
        }
    `;

    const response = await fetch(linearEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: process.env.LINEAR_API_KEY
        },
        body: JSON.stringify({ query })
    });
    const data = await response.json();
    const team = data.data?.teams?.nodes?.[0];

    if(!team) {
        throw new Error(`Team with key "${teamKey}" not found. Check your LINEAR_TEAM_KEY environment variable.`);
    }
    cachedTeamId = team.id;
    return cachedTeamId;
}

export async function createLinearTicket({text, owner, deadline}) {
    const teamId = await getTeamId(process.env.LINEAR_TEAM_KEY);

    const description = [
        owner && owner !== 'unspecified' ? `**Owner:** ${owner}` : null,
        deadline && deadline !== 'none' ? `**Deadline:** ${deadline}` : null,
        '_Created automatically by AI Meeting Co-Pilot_'
    ].filter(Boolean).join('\n\n');

    const mutation = `
        mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
            success
            issue { id identifier title url }
        }
        }
    `;

    const variables = {
        input: {
            teamId,
            title: text.length > 100 ? text.substring(0, 97) + '...' : text,
            description
        }
    };

    const response = await fetch(linearEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: process.env.LINEAR_API_KEY
        },
        body: JSON.stringify({ query: mutation, variables })
    });

    const data = await response.json();
    if (!data.data?.issueCreate?.success) {
        throw new Error('Linear ticket creation failed: ' + JSON.stringify(data.errors || data));    
    }
    return data.data.issueCreate.issue;
}