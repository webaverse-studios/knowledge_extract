/**
 * The Knowledge Extractor
 * Intercept the user messages and extract the requested knowledge
 */


const supported_types = ["string", "number", "boolean", "object", "array"]
let knowledge = {};
let force = false; // Force the user to answer the questions

export function handleStart(event) {
    if (knowledge.length > 0){
        window.logger.error("Knowledge extraction pipeline already in use", knowledge);
        return;
    }

    // Validate requested knowledge
    const errors = [];
    for (const [k, v] of Object.entries(event.requested_knowledge)){
        if (!k || typeof(k) !== "string"){
            errors.push("Key is the name and it must be a string", k); 
        }

        if (!v || typeof(v) !== "object"){
            errors.push("Value must be an object containing 'type', 'name' and 'description' and optional 'enum'", v);
            continue;
        }

        if (!v.type || typeof(v.type) !== "string"){
            errors.push("'type' must be a string, type:", v.type);
        }

        if (!supported_types.includes(v.type)){
            errors.push("Invalid 'type' requested", v.type, "Must be one of: ", supported_types);
        }

        if (!v.description || typeof(v.description) !== "string"){
            errors.push("'description' must be a string", v.description);
        }

        if (!v.question || typeof(v.question) !== "string"){
            errors.push("'question' must be a string", v.question);
        }
    }

    if (event.force!==false && event.force!==true){
        errors.push("'force' must be a boolean", event.force);
    }

    // If there are errors, log them and return
    if (errors.length > 0){
        window.logger.error("Errors in requested knowledge:", knowledge, "Errors: ", errors);
        return;
    }

    // Set up knowledge
    knowledge = event.requested_knowledge;

    // Set up types
    force = event.force;

    if (force){
        window.hooks.on("user_message", async (event) => await handleUserMessage(event));
    } else {
        window.hooks.on("set_prompts", ({model, type}) => _handleSetPrompts(model, type));
    }
}


async function handleUserMessage(event){
    const message = event.value;

    // Extract the knowledge from the message
    await extract(message);

    const questions = getQuestions();

    if (questions.length !== 0){
        window.skills_llm.CallSkill(model, 'TEXT', { value: questions[0] }); // ask one question at a time
        return true; // Return true to prevent the normal flow
    } 

    // If we get here, we have all the values
    window.logger.info("Extracted all values", knowledge);
    window.hooks.off("user_message", async (event) => await handleUserMessage(event)); // Remove the hook
    window.hooks.emit("k_extract:handle_complete", knowledge); // Emit the event
}


function nullCheck(value){
    if (value === null || value === "null"){
        return null;
    }
    return value;
}


async function extract(message){
    const fields = knowledge.filter(obj => !obj.value);

    const extractModel = window.models.CreateModel("GPT 3.5 Turbo");

    window.models.ApplyContextObject(extractModel, {fields, message});
    window.prompts_llm.SetPrompt(extractModel, 'moemate-email:extract', { role: 'system' });
    const extracted = await window.models.CallModel(extractModel, {prompts: "extract"}, {timeout: 10000});
    window.models.DestroyModel(extractModel);

    let json = JSON.parse(extracted);

    json = json.filter(obj => nullCheck(obj));

    for (let [k, v] of Object.entries(json)){
        if (!knowledge[k]) continue; // If we don't know about this field, skip it
        if (typeof(v) !== knowledge[k].type) continue; // If the type is wrong, skip it
        knowledge[k].value = v; // Set the value
    }
}

function getQuestions(){
    const questions = [];
    for (const [k, v] of Object.entries(knowledge)){
        if (v.value === undefined){
            questions.push(v.question);
        }
    }
    return questions;
}


async function _handleSetPrompts(model, type) {
    switch (type) {
        case 'chat':
        case 'force questions and chat':
            const recent_conversation = window.models.GetContextObject(model, 'recent_conversation');
            const last_message = recent_conversation[recent_conversation.length - 1];

            // Extract the knowledge from the message
            await extract(last_message);

            const questions = getQuestions();

            if (questions.length === 0){
                window.logger.info("Extracted all values", knowledge);
                window.hooks.off("set_prompts", ({model, type}) => _handleSetPrompts(model, type));
                window.hooks.emit("k_extract:handle_complete", knowledge); // Emit the event
                return;
            }

            window.models.ApplyContextObject(model, {questions});
            window.prompts_llm.SetPrompt(model, "k_extract:add_question", { role: 'system' });
            break;
    }
}

export function init() {
    window.hooks.on("k_extract:handle_start", (event) => handleStart(event));
}

