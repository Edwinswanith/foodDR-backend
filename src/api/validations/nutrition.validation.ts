import Ajv, { JSONSchemaType } from "ajv";
import { NutritionProfileReq } from "../interface/nutrition.interface";

const ajv = new Ajv({ allErrors: true })
require("ajv-errors")(ajv /*, {singleError: true} */)

const currentYear = () => new Date().getFullYear();

const upperSnake = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    return String(value).trim().replace(/[\s-]+/g, "_").toUpperCase();
};

const lowerSnake = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    return String(value).trim().replace(/[\s-]+/g, "_").toLowerCase();
};

const normalizeHeightUnit = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const raw = String(value).trim();
    const sqlStringMatch = raw.match(/^N?'([^']+)'$/i);
    const unit = (sqlStringMatch?.[1] ?? raw).trim().toLowerCase();
    const map: Record<string, string> = {
        cm: "CM",
        cms: "CM",
        centimeter: "CM",
        centimeters: "CM",
        ft: "FT",
        feet: "FT",
        foot: "FT",
    };
    return map[unit] ?? upperSnake(unit);
};

const normalizeGoal = (value: unknown): string | undefined => {
    const key = lowerSnake(value);
    const map: Record<string, string> = {
        lose_weight: "WEIGHT_LOSS",
        weight_loss: "WEIGHT_LOSS",
        gain_muscle: "MUSCLE_GAIN",
        muscle_gain: "MUSCLE_GAIN",
        build_muscle: "MUSCLE_GAIN",
        balanced: "BALANCED_NUTRITION",
        balanced_nutrition: "BALANCED_NUTRITION",
        maintain_weight: "BALANCED_NUTRITION",
        medical_recovery: "MEDICAL_RECOVERY",
        energy_boost: "ENERGY_BOOST",
    };
    return key ? map[key] ?? upperSnake(key) : undefined;
};

const normalizeActivityLevel = (value: unknown): string | undefined => {
    const key = lowerSnake(value);
    const map: Record<string, string> = {
        sedentary: "sedentary",
        light: "light",
        lightly_active: "light",
        moderate: "moderate",
        moderately_active: "moderate",
        active: "active",
        very_active: "very_active",
        intense: "very_active",
        highly_active: "very_active",
    };
    return key ? map[key] ?? key : undefined;
};

const stringifyValue = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    return String(value);
};

export const normalizeNutritionProfileBody = (body: any) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return body;
    }

    const normalized = { ...body };

    if (normalized.age === undefined && normalized.birth_year !== undefined) {
        const birthYear = Number(normalized.birth_year);
        if (Number.isFinite(birthYear) && birthYear > 1900) {
            normalized.age = currentYear() - birthYear;
        }
    }

    if (normalized.height === undefined) {
        normalized.height = stringifyValue(normalized.current_height);
    } else {
        normalized.height = stringifyValue(normalized.height);
    }

    if (normalized.weight === undefined) {
        normalized.weight = stringifyValue(normalized.current_weight);
    } else {
        normalized.weight = stringifyValue(normalized.weight);
    }

    if (normalized.goal_weight !== undefined) {
        normalized.goal_weight = stringifyValue(normalized.goal_weight);
    }

    normalized.gender = upperSnake(normalized.gender) ?? normalized.gender;
    normalized.height_unit = normalizeHeightUnit(normalized.height_unit) ?? normalized.height_unit;
    normalized.weight_unit = upperSnake(normalized.weight_unit) ?? normalized.weight_unit;
    normalized.diet_type = normalized.diet_type === null ? null : upperSnake(normalized.diet_type) ?? normalized.diet_type;

    if (normalized.food_preferences === undefined && normalized.preferred_cuisines !== undefined) {
        normalized.food_preferences = Array.isArray(normalized.preferred_cuisines)
            ? normalized.preferred_cuisines.map(upperSnake).filter(Boolean).join(",")
            : upperSnake(normalized.preferred_cuisines);
    }
    if (normalized.food_preferences !== null && normalized.food_preferences !== undefined) {
        normalized.food_preferences = String(normalized.food_preferences).trim().toUpperCase();
    }

    if (normalized.primary_goal === undefined && normalized.goal !== undefined) {
        normalized.primary_goal = normalizeGoal(normalized.goal);
    } else if (normalized.primary_goal !== null && normalized.primary_goal !== undefined) {
        normalized.primary_goal = normalizeGoal(normalized.primary_goal);
    }
    if (normalized.secondary_goal !== null && normalized.secondary_goal !== undefined) {
        normalized.secondary_goal = normalizeGoal(normalized.secondary_goal);
    }

    if (normalized.activity_level !== undefined) {
        normalized.activity_level = normalizeActivityLevel(normalized.activity_level);
    }

    if (normalized.age !== undefined) {
        const age = Number(normalized.age);
        normalized.age = Number.isFinite(age) ? age : normalized.age;
    }
    if (normalized.energy_level !== null && normalized.energy_level !== undefined) {
        const energyLevel = Number(normalized.energy_level);
        normalized.energy_level = Number.isFinite(energyLevel) ? energyLevel : normalized.energy_level;
    }
    if (normalized.meals_per_day !== null && normalized.meals_per_day !== undefined) {
        const mealsPerDay = Number(normalized.meals_per_day);
        normalized.meals_per_day = Number.isFinite(mealsPerDay) ? mealsPerDay : normalized.meals_per_day;
    }
    if (normalized.water_intake !== null && normalized.water_intake !== undefined) {
        normalized.water_intake = String(normalized.water_intake);
    }
    normalized.water_intake_unit = normalized.water_intake_unit === null
        ? null
        : upperSnake(normalized.water_intake_unit) ?? normalized.water_intake_unit;

    delete normalized.birth_year;
    delete normalized.current_weight;
    delete normalized.current_height;
    delete normalized.goal;
    delete normalized.aggressiveness;
    delete normalized.preferred_cuisines;
    delete normalized.body_fat_percentage;

    return normalized;
};



export const nutritionProfileSchema: JSONSchemaType<NutritionProfileReq> = {
    type: "object",
    properties: {
        age: {
            type: "number",
            minimum: 1
        },

        gender: {
            type: "string",
            enum: ["MALE", "FEMALE", "OTHER"]
        },

        height: {
            type: "string",
            minLength: 1
        },

        height_unit: {
            type: "string",
            enum: ["CM", "FT"]
        },

        weight: {
            type: "string",
            minLength: 1
        },

        weight_unit: {
            type: "string",
            enum: ["KG", "LB"]
        },

        goal_weight: {
            type: "string",
            nullable: true
        },

        body_type: {
            type: "string",
            nullable: true
        },

        activity_level: {
            type: "string",
            enum: ["sedentary", "light", "moderate", "active", "very_active"]
        },

        diet_type: {
            type: "string",
            nullable: true,
            enum: ["VEGETARIAN", "VEGAN", "EGGETARIAN", "NON_VEGETARIAN"]
        },

        food_preferences: {
            type: "string",
            nullable: true
        },

        primary_goal: {
            type: "string",
            nullable: true,
            enum: [
                "WEIGHT_LOSS",
                "MUSCLE_GAIN",
                "BALANCED_NUTRITION",
                "MEDICAL_RECOVERY",
                "ENERGY_BOOST"
            ]
        },

        secondary_goal: {
            type: "string",
            nullable: true,
            enum: [
                "WEIGHT_LOSS",
                "MUSCLE_GAIN",
                "BALANCED_NUTRITION",
                "MEDICAL_RECOVERY",
                "ENERGY_BOOST",
                "IMPROVE_SLEEP",
                "STRESS_REDUCTION"
            ]
        },

        health_conditions: {
            type: "string",
            nullable: true
        },

        energy_level: {
            type: "number",
            nullable: true,
            minimum: 0,
            maximum: 10
        },

        meals_per_day: {
            type: "number",
            nullable: true,
            minimum: 1,
            maximum: 6
        },

        water_intake: {
            type: "string",
            nullable: true
        },

        water_intake_unit: {
            type: "string",
            nullable: true,
            enum: ["LTR", "ML"]
        }
    },

    required: [
        "age",
        "gender",
        "height",
        "height_unit",
        "weight",
        "weight_unit",
        "activity_level"
    ],

    additionalProperties: false,

    errorMessage: {
        required: {
            age: "Age is required",
            gender: "Gender is required",
            height: "Height is required",
            height_unit: "Height unit is required",
            weight: "Weight is required",
            weight_unit: "Weight unit is required",
            activity_level: "Activity level is required"
        },
        additionalProperties: "No additional properties are allowed"
    }
};
