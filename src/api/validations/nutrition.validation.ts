import Ajv, { JSONSchemaType } from "ajv";
import { NutritionProfileReq } from "../interface/nutrition.interface";

const ajv = new Ajv({ allErrors: true })
require("ajv-errors")(ajv /*, {singleError: true} */)



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