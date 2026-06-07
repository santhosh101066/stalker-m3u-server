import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

@Table({
    tableName: "user_progress",
    timestamps: true,
})
export class UserProgress extends Model {
    @PrimaryKey
    @Column(DataType.INTEGER)
    userId!: number;

    @PrimaryKey
    @Column(DataType.INTEGER)
    profileId!: number;

    @PrimaryKey
    @Column(DataType.STRING)
    mediaId!: string;

    @Column(DataType.FLOAT)
    progress!: number; // time in seconds

    @Column(DataType.BOOLEAN)
    completed!: boolean;

    @Column(DataType.JSON)
    meta!: Record<string, any>;
}
